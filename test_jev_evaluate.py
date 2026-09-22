"""Tests of evaluator/controller logic only. Candidate code is never executed."""

import copy
import json
import unittest
from unittest.mock import patch

import jev_evaluate as jev


class EvaluatorTests(unittest.TestCase):
    def setUp(self):
        self.source = 'raise RuntimeError("candidate must never execute")'
        self.rubric = copy.deepcopy(jev.DEFAULT_RUBRIC)
        self.payload = jev.build_request(self.source, self.rubric)
        self.raw = {"model": jev.DEFAULT_MODEL, "answers": {}}
        for target in self.rubric["targets"]:
            self.raw["answers"][target["id"]] = (
                {"type": "noul", "noul": 0.99} if target["type"] == "noul" else
                {"type": "score", "score": 3.0, "confidence": 1.0,
                 "probabilities": {"0": 0.0, "1": 0.0, "2": 0.0, "3": 1.0}}
            )

    def report(self):
        return jev.make_report(self.source, self.rubric, self.payload, self.raw, jev.DEFAULT_POLICY)

    def score(self, target_id, value):
        self.raw["answers"][target_id] = {
            "type": "score", "score": float(value), "confidence": 1.0,
            "probabilities": {str(i): float(i == value) for i in range(4)},
        }

    def test_evaluate_does_not_execute_candidate(self):
        with patch.object(jev, "ask_jev", return_value=self.raw):
            report = jev.evaluate(self.source, api_key="test")
        self.assertEqual(report["decision"], "rubric_satisfied")

    def test_missing_answer_rejected(self):
        del self.raw["answers"]["interface"]
        with self.assertRaises(ValueError):
            self.report()

    def test_nan_rejected(self):
        self.raw["answers"]["interface"]["noul"] = float("nan")
        with self.assertRaises(ValueError):
            self.report()

    def test_invalid_distribution_rejected(self):
        self.raw["answers"]["readability"]["probabilities"]["0"] = 0.4
        with self.assertRaises(ValueError):
            self.report()

    def test_independently_rounded_score_is_accepted(self):
        self.raw["answers"]["literal_class_lookup"].update(
            score=2.52, probabilities={"0": 0.01, "1": 0.07, "2": 0.33, "3": 0.59})
        self.report()

    def test_materially_inconsistent_score_is_rejected(self):
        self.raw["answers"]["readability"]["score"] = 2.5
        with self.assertRaises(ValueError):
            self.report()

    def test_uncertainty_is_not_confirmed_failure(self):
        self.raw["answers"]["interface"]["noul"] = 0.6
        report = self.report()
        self.assertEqual(report["targets"][0]["status"], "uncertain")
        self.assertIn("interface", report["investigate_ids"])

    def test_structural_findings_precede_uncertain_cosmetics(self):
        self.raw["answers"]["source_format"]["noul"] = 0.45
        self.raw["answers"]["empty_expressions"]["noul"] = 0.7
        self.raw["answers"]["parser_stack_safety"]["noul"] = 0.02
        self.raw["answers"]["compiler_stack_safety"]["noul"] = 0.03
        self.raw["answers"]["interpreter_settings"]["noul"] = 0.04
        self.assertEqual(self.report()["focus_ids"], [
            "parser_stack_safety", "compiler_stack_safety", "interpreter_settings",
        ])

    def test_removing_override_does_not_satisfy_stack_targets(self):
        self.raw["answers"]["parser_stack_safety"]["noul"] = 0.01
        self.raw["answers"]["compiler_stack_safety"]["noul"] = 0.01
        report = self.report()
        self.assertFalse(report["essential_targets_met"])
        self.assertEqual(report["decision"], "revise")
        feedback = json.loads(report["revision_messages"][1]["content"])["jev_feedback"]
        settings = next(row for row in feedback if row["id"] == "interpreter_settings")
        self.assertEqual(settings["preserve_targets"], ["parser_stack_safety", "compiler_stack_safety"])

    def test_duplicate_target_rejected(self):
        self.rubric["targets"].append(copy.deepcopy(self.rubric["targets"][0]))
        with self.assertRaises(ValueError):
            jev.build_request(self.source, self.rubric)

    def test_missing_guard_rejected(self):
        self.rubric["targets"][0]["preserve_targets"] = ["unknown"]
        with self.assertRaises(ValueError):
            jev.build_request(self.source, self.rubric)

    def test_same_mean_different_threshold_probability(self):
        self.raw["answers"]["readability"].update(
            score=2.4, probabilities={"0": 0.2, "1": 0.0, "2": 0.0, "3": 0.8})
        first = next(r for r in self.report()["targets"] if r["id"] == "readability")
        self.raw["answers"]["readability"]["probabilities"] = {"0": 0.0, "1": 0.0, "2": 0.6, "3": 0.4}
        second = next(r for r in self.report()["targets"] if r["id"] == "readability")
        self.assertEqual(first["probability_meets_target"], 0.8)
        self.assertEqual(second["probability_meets_target"], 1.0)

    def test_benchmark_gap_even_when_both_meet_minimum(self):
        benchmark = self.report()
        self.score("phase_boundaries", 2)
        candidate = self.report()
        self.assertEqual(candidate["decision"], "rubric_satisfied")
        jev.attach_comparisons(self.source, candidate, benchmark, None)
        self.assertEqual(candidate["decision"], "revise")
        self.assertIn("phase_boundaries", candidate["focus_ids"])
        self.assertEqual(candidate["benchmark_status"], "quality_gaps_remain")

    def test_possible_essential_regression_blocks_promotion(self):
        previous = self.report()
        self.raw["answers"]["full_match"]["noul"] = 0.88
        comparison = jev.compare_reports(self.report(), previous)
        self.assertEqual(comparison["recommendation"], "hold_possible_regression")
        self.assertIn("full_match", comparison["possible_essential_regressions"])

    def test_cosmetic_gain_is_not_implementation_gain(self):
        self.score("explanation", 1)
        previous = self.report()
        self.score("explanation", 3)
        comparison = jev.compare_reports(self.report(), previous)
        self.assertEqual(comparison["recommendation"], "no_material_implementation_gain")

    def test_mixed_quality_changes_are_tradeoffs(self):
        self.score("literal_class_lookup", 1)
        previous = self.report()
        self.score("literal_class_lookup", 3)
        self.score("phase_boundaries", 1)
        self.assertEqual(jev.compare_reports(self.report(), previous)["recommendation"], "tradeoff")

    def test_small_changes_are_not_material(self):
        previous = self.report()
        self.raw["answers"]["full_match"]["noul"] = 0.95
        comparison = jev.compare_reports(self.report(), previous)
        self.assertEqual(comparison["gaps"], [])
        self.assertEqual(comparison["recommendation"], "no_material_implementation_gain")

    def test_incompatible_reference_rejected_before_api(self):
        previous = self.report()
        previous["schema_version"] = 1
        with patch.object(jev, "ask_jev") as ask:
            with self.assertRaises(ValueError):
                jev.evaluate(self.source, api_key="test", previous_report=previous)
            ask.assert_not_called()

    def test_tampered_reference_summary_rejected(self):
        previous = self.report()
        previous["targets"][0]["status"] = "likely_violation"
        with self.assertRaises(ValueError):
            jev.check_reference(previous, self.rubric, jev.DEFAULT_POLICY, jev.DEFAULT_MODEL)

    def test_valid_reference_accepted(self):
        jev.check_reference(self.report(), self.rubric, jev.DEFAULT_POLICY, jev.DEFAULT_MODEL)

    def test_benchmark_code_not_sent_to_candidate_judge_or_generator(self):
        benchmark_source = '# unique benchmark source\ndef match(p, t): return False'
        benchmark_payload = jev.build_request(benchmark_source, self.rubric)
        benchmark = jev.make_report(benchmark_source, self.rubric, benchmark_payload, self.raw, jev.DEFAULT_POLICY)
        self.score("phase_boundaries", 2)
        with patch.object(jev, "ask_jev", return_value=self.raw) as ask:
            candidate = jev.evaluate(self.source, api_key="test", benchmark_report=benchmark)
        self.assertNotIn("unique benchmark source", json.dumps(ask.call_args.args[0]))
        self.assertNotIn("unique benchmark source", json.dumps(candidate["revision_messages"]))


if __name__ == "__main__":
    unittest.main()

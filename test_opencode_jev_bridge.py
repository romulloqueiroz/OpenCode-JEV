import copy
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

import jev_evaluate as jev
import opencode_jev_bridge as bridge


def fake_report(source, rubric, **kwargs):
    payload = jev.build_request(source, rubric)
    raw = {"model": jev.DEFAULT_MODEL, "answers": {}}
    for target in rubric["targets"]:
        raw["answers"][target["id"]] = ({"type": "noul", "noul": 0.4} if target["type"] == "noul" else {"type": "score", "score": 2.0, "confidence": 1.0, "probabilities": {"0": 0.0, "1": 0.0, "2": 1.0, "3": 0.0}})
    return jev.make_report(source, rubric, payload, raw, jev.DEFAULT_POLICY)


class BridgeTests(unittest.TestCase):
    def test_generic_rubric_is_stable_and_task_grounded(self):
        first = bridge.generic_rubric("Add a CSV importer.")
        second = bridge.generic_rubric("Add a CSV importer.")
        self.assertEqual(first, second)
        self.assertIn("Add a CSV importer.", first["specification"])
        self.assertIn("do not invent requirements", first["specification"])

    def test_bundle_is_sorted_and_delimited(self):
        bundled = bridge.source_bundle([{"path": "z.py", "content": "z"}, {"path": "a.py", "content": "a"}])
        self.assertLess(bundled.index("a.py"), bundled.index("z.py"))
        self.assertIn("===== BEGIN FILE: a.py =====", bundled)

    def test_custom_rubric_and_previous_report_forwarded(self):
        rubric = copy.deepcopy(jev.DEFAULT_RUBRIC)
        previous = {"schema_version": 2}
        with patch.object(bridge.jev, "api_key_from_env", return_value="secret"), patch.object(bridge.jev, "evaluate", side_effect=lambda source, **kw: fake_report(source, kw["rubric"])) as evaluate:
            result = bridge.handle({"task": "x", "files": [{"path": "x", "content": "source"}], "rubric": rubric, "previous_report": previous})
        self.assertEqual(result["report"]["rubric"], rubric)
        self.assertIn("feedback", result)
        self.assertIs(evaluate.call_args.kwargs["previous_report"], previous)
        self.assertEqual(evaluate.call_args.kwargs["timeout"], 60.0)

    def test_real_evaluate_roundtrip_with_previous_report_is_offline(self):
        task = "Implement x"
        files = [{"path": "x.py", "content": "source"}]
        rubric = bridge.generic_rubric(task)
        source = bridge.source_bundle(files)
        payload = jev.build_request(source, rubric)
        raw = {"model": jev.DEFAULT_MODEL, "answers": {}}
        for target in rubric["targets"]:
            raw["answers"][target["id"]] = ({"type": "noul", "noul": 0.99} if target["type"] == "noul" else {"type": "score", "score": 3.0, "confidence": 1.0, "probabilities": {"0": 0.0, "1": 0.0, "2": 0.0, "3": 1.0}})
        with patch.object(bridge.jev, "api_key_from_env", return_value="secret"), patch.object(bridge.jev, "ask_jev", return_value=raw):
            prior = bridge.jev.evaluate(source, rubric=rubric, api_key="secret", timeout=12.0)
            result = bridge.handle({"task": task, "files": files, "previous_report": prior, "timeout": 12})
        self.assertEqual(result["report"]["previous_comparison"]["recommendation"], "no_material_implementation_gain")
        self.assertEqual(result["report"]["revision_messages"], [])

    def test_feedback_mentions_preservation_and_uncertainty(self):
        rubric = bridge.generic_rubric("x")
        report = fake_report("source", rubric)
        report["focus_ids"].append("redundant_work")
        feedback = bridge.concise_feedback(report)
        self.assertIn("Preserve", feedback)
        self.assertIn("Uncertain", feedback)
        self.assertIn("Current score", feedback)
        messages = bridge.bridge_revision_messages("source", report)
        self.assertIn("workspace", messages[0]["content"])
        self.assertIn("caller's requested format", messages[0]["content"])
        self.assertIn("do not change the live workspace", messages[0]["content"])

    def test_malformed_requests_fail_cli(self):
        proc = subprocess.run([sys.executable, "opencode_jev_bridge.py"], input=b'{"task":"","files":[]}', capture_output=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"Error:", proc.stderr)

    def test_malformed_fields_are_rejected(self):
        cases = [
            {"task": "x", "files": [{"path": "a", "content": "x"}, {"path": "a", "content": "y"}]},
            {"task": "x", "files": [{"path": "a", "content": "x"}], "timeout": float("nan")},
            {"task": "x", "files": [{"path": "a", "content": "x"}], "rubric": []},
        ]
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(ValueError):
                    bridge.validate_request(case)

    def test_route_asks_one_yes_no_question_about_the_latest_message(self):
        sent = {}
        def fake_ask(payload, api_key, timeout):
            sent.update(payload)
            return {"model": jev.DEFAULT_MODEL, "answers": {"needs_code": {"type": "noul", "noul": 0.12}}}
        with patch.object(jev, "ask_jev", fake_ask), patch.object(jev, "api_key_from_env", lambda: "key"):
            result = bridge.handle({"mode": "route", "latest": "Why is the sky blue?", "conversation": "user:\nhi", "timeout": 5})
        self.assertEqual(result, {"needs_code": 0.12})
        self.assertEqual(sent["state"], {"conversation": "user:\nhi", "latest_message": "Why is the sky blue?"})
        self.assertEqual(list(sent["questions"]), ["needs_code"])
        self.assertEqual(sent["questions"]["needs_code"]["type"], "noul")

    def test_route_rejects_bad_input_and_bad_answers(self):
        with self.assertRaises(ValueError):
            bridge.handle({"mode": "route", "latest": ""})
        bad = lambda payload, api_key, timeout: {"answers": {"needs_code": {"type": "noul", "noul": 7}}}
        with patch.object(jev, "ask_jev", bad), patch.object(jev, "api_key_from_env", lambda: "key"):
            with self.assertRaises(ValueError):
                bridge.handle({"mode": "route", "latest": "hi"})


if __name__ == "__main__":
    unittest.main()

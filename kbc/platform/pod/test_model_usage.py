import unittest

from model_usage import ClaudeUsageRecorder


class Sink:
    def __init__(self):
        self.events = []

    async def emit(self, kind, data, turn_id):
        self.events.append(data["observation"])


class ModelUsageTests(unittest.IsolatedAsyncioTestCase):
    def make(self):
        sink = Sink()
        recorder = ClaudeUsageRecorder("session", {"role": "judge", "model": {
            "id": "example", "provider": "gateway", "name": "Example"}}, sink)
        return recorder, sink

    async def test_native_cache_usage_and_terminal_are_recorded_once(self):
        recorder, sink = self.make()
        await recorder.observe({"type": "message_start", "message": {"id": "response", "usage": {
            "input_tokens": 3, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 20}}}, "turn")
        await recorder.observe({"type": "message_delta", "usage": {"output_tokens": 5}}, "turn")
        await recorder.observe({"type": "message_stop"}, "turn")
        await recorder.record_unobserved("response", "turn")
        await recorder.finish("success", "turn")
        self.assertEqual(len(sink.events), 2)
        self.assertEqual(sink.events[0]["callId"], sink.events[1]["callId"])
        evidence = sink.events[1]["usageEvidence"]
        self.assertEqual(evidence["protocol"], "anthropic")
        self.assertEqual(evidence["finality"], "terminal")
        self.assertEqual(evidence["rawUsage"], {"input_tokens": 3, "output_tokens": 5,
                         "cache_read_input_tokens": 0, "cache_creation_input_tokens": 20})
        self.assertEqual(sink.events[1]["executorRole"], "judge")

    async def test_transport_failure_preserves_partial_evidence(self):
        recorder, sink = self.make()
        await recorder.observe({"type": "message_start", "message": {"id": "response", "usage": {"input_tokens": 0}}}, "turn")
        await recorder.finish("error", "turn")
        evidence = sink.events[-1]["usageEvidence"]
        self.assertEqual(evidence["rawUsage"], {"input_tokens": 0})
        self.assertEqual(evidence["finality"], "intermediate")
        self.assertEqual(sink.events[-1]["outcome"], "error")

    async def test_sdk_only_message_is_unknown_and_repeated_blocks_do_not_duplicate(self):
        recorder, sink = self.make()
        await recorder.record_unobserved("sdk-message", "turn")
        await recorder.record_unobserved("sdk-message", "turn")
        self.assertEqual(len(sink.events), 1)
        self.assertNotIn("usageEvidence", sink.events[0])

    async def test_request_contents_are_never_copied_into_evidence(self):
        recorder, sink = self.make()
        await recorder.observe({"type": "message_start", "message": {"usage": {
            "input_tokens": "secret", "output_tokens": 0, "prompt": "private"}}}, "turn")
        await recorder.observe({"type": "message_stop"}, "turn")
        self.assertEqual(sink.events[-1]["usageEvidence"]["rawUsage"], {"input_tokens": "invalid", "output_tokens": 0})


if __name__ == "__main__":
    unittest.main()

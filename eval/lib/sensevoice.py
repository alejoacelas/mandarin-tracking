import sys, json, wave, numpy as np, sherpa_onnx, os
d = os.path.expanduser("~/.cache/sensevoice/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17")
rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f"{d}/model.int8.onnx", tokens=f"{d}/tokens.txt", use_itn=False, num_threads=4)
for f in sys.argv[1:]:
    with wave.open(f) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    s = rec.create_stream(); s.accept_waveform(16000, a); rec.decode_stream(s)
    r = s.result
    print(json.dumps({"file": f, "lang": r.lang, "event": r.event, "text": r.text}, ensure_ascii=False))

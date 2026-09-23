#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--voice", required=True)
    args = parser.parse_args()

    try:
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
    except Exception as exc:
        emit({
            "type": "ready",
            "error": "Dependências do TTS não estão instaladas: " + str(exc),
        })
        print(
            "Dependências ausentes. Execute npm run audio:setup.",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(2)

    try:
        print(
            "Carregando modelo local " + args.model + "...",
            file=sys.stderr,
            flush=True,
        )

        model = Qwen3TTSModel.from_pretrained(
            args.model,
            device_map="cpu",
            dtype=torch.float32,
            attn_implementation="sdpa",
        )

        print(
            "Modelo de voz local carregado.",
            file=sys.stderr,
            flush=True,
        )
        emit({"type": "ready"})
    except Exception as exc:
        emit({
            "type": "ready",
            "error": "Falha ao carregar o modelo: " + str(exc),
        })
        print(
            "Falha ao carregar Qwen3-TTS: " + str(exc),
            file=sys.stderr,
            flush=True,
        )
        sys.exit(3)

    for raw_line in sys.stdin:
        line = raw_line.strip()

        if not line:
            continue

        request = {}

        try:
            request = json.loads(line)
            request_id = int(request["id"])
            text = str(request["text"]).strip()
            output = Path(request["output"])
            language = str(request.get("language", "Portuguese"))

            output.parent.mkdir(parents=True, exist_ok=True)

            wavs, sample_rate = model.generate_voice_design(
                text=text,
                language=language,
                instruct=args.voice,
            )

            sf.write(str(output), wavs[0], sample_rate)

            emit({
                "type": "result",
                "id": request_id,
                "ok": True,
                "path": str(output),
            })
        except Exception as exc:
            request_id = int(request.get("id", -1))

            emit({
                "type": "result",
                "id": request_id,
                "ok": False,
                "error": str(exc),
            })

            print(
                "Falha na síntese: " + str(exc),
                file=sys.stderr,
                flush=True,
            )


if __name__ == "__main__":
    main()

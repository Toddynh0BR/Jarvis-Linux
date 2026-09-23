#!/usr/bin/env python3
import argparse
import gc
import json
import sys
from pathlib import Path


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model(model_id, torch):
    from qwen_tts import Qwen3TTSModel

    return Qwen3TTSModel.from_pretrained(
        model_id,
        device_map="cpu",
        dtype=torch.float32,
        attn_implementation="sdpa",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--design-model", required=True)
    parser.add_argument("--clone-model", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--reference-text", required=True)
    args = parser.parse_args()

    try:
        import soundfile as sf
        import torch
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

    reference_path = Path(args.reference)
    reference_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        if not reference_path.exists():
            print(
                "Criando a voz base do Jarvis com VoiceDesign...",
                file=sys.stderr,
                flush=True,
            )

            design_model = load_model(args.design_model, torch)

            wavs, sample_rate = design_model.generate_voice_design(
                text=args.reference_text,
                language="Portuguese",
                instruct=args.voice,
            )

            sf.write(str(reference_path), wavs[0], sample_rate)

            del design_model
            gc.collect()

            print(
                "Referência de voz criada e salva localmente.",
                file=sys.stderr,
                flush=True,
            )

        print(
            "Carregando modelo local de clonagem " + args.clone_model + "...",
            file=sys.stderr,
            flush=True,
        )

        clone_model = load_model(args.clone_model, torch)

        print(
            "Preparando a assinatura vocal do Jarvis...",
            file=sys.stderr,
            flush=True,
        )

        voice_clone_prompt = clone_model.create_voice_clone_prompt(
            ref_audio=str(reference_path),
            ref_text=args.reference_text,
            x_vector_only_mode=False,
        )

        print(
            "Motor de voz local pronto.",
            file=sys.stderr,
            flush=True,
        )
        emit({"type": "ready"})
    except Exception as exc:
        emit({
            "type": "ready",
            "error": "Falha ao preparar a voz do Jarvis: " + str(exc),
        })
        print(
            "Falha ao preparar Qwen3-TTS: " + str(exc),
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

            wavs, sample_rate = clone_model.generate_voice_clone(
                text=text,
                language=language,
                voice_clone_prompt=voice_clone_prompt,
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

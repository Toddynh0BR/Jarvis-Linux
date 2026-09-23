# Áudio do Jarvis

A Fase 3 começa com TTS local. O terminal continua sendo a interface de entrada, mas cada resposta textual do Jarvis também é sintetizada e reproduzida no computador.

## Arquitetura

`texto do Agent -> Qwen3-TTS -> WAV temporário -> reprodutor local`

A voz é construída em duas etapas para manter identidade entre respostas:

1. Qwen3-TTS VoiceDesign 1.7B cria uma referência de voz a partir da descrição da voz do Jarvis.
2. Qwen3-TTS Base 0.6B usa essa referência para sintetizar as respostas seguintes.

A referência fica em:

`~/.local/share/jarvis/tts/jarvis_voice_reference.wav`

O motor de inferência é local. O primeiro uso baixa os modelos do Hugging Face para o cache local; depois da instalação e do download não existe chamada de TTS para uma API externa.

## Instalação

Execute:

`npm run audio:setup`

Depois:

`npm start`

Na primeira fala, o download dos modelos pode ser grande e a primeira inicialização pode demorar. Isso é esperado.

## Voz

A descrição padrão é uma voz masculina brasileira, grave, aveludada, calma, precisa, sofisticada e tecnológica, sem imitar uma pessoa real.

É possível experimentar outra descrição sem alterar o código:

`JARVIS_TTS_VOICE="Voz masculina brasileira..." npm start`

Também é possível trocar os checkpoints:

- `JARVIS_TTS_DESIGN_MODEL`
- `JARVIS_TTS_CLONE_MODEL`

O texto usado para criar a referência pode ser alterado com:

`JARVIS_TTS_REFERENCE_TEXT`

## Reprodução

O Jarvis procura, nesta ordem:

1. `pw-play`
2. `paplay`
3. `aplay`
4. `ffplay`

Se o TTS falhar, a resposta textual continua funcionando normalmente.

## Próxima etapa

A próxima parte da Fase 3 é adicionar entrada por microfone com VAD + ASR local, sem modificar o Agent.

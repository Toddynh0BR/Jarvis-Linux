# Áudio do Jarvis

A Fase 3 usa TTS local com prioridade para um backend nativo otimizado do Qwen3-TTS.

## Arquitetura atual

`texto do Agent -> Qwen3-TTS nativo C -> streaming PCM -> SoX/PipeWire`

O backend nativo mantém o modelo carregado em um servidor local durante a execução do Jarvis. Isso evita iniciar Python e PyTorch a cada resposta e permite que o áudio seja reproduzido enquanto ainda está sendo gerado.

O backend usado no Jarvis é o Qwen3-TTS 0.6B, compilado para CPU e executado por padrão com INT4 e quatro threads. A escolha de INT4 é deliberada para CPUs x86 Zen3/AVX2 com cache limitado, onde a redução do tráfego de pesos é mais importante que uma largura SIMD maior.

O projeto nativo também oferece INT8, mas o Jarvis começa com INT4 para priorizar latência no Ryzen 5 5600GT. O desempenho real deve ser medido no computador do usuário.

## Backend nativo

O Jarvis usa o projeto Qwen3-TTS em C:

`https://github.com/gabriele-mastrapasqua/qwen3-tts`

O backend fornece:

- inferência sem Python e sem PyTorch;
- otimizações AVX2 para CPUs x86;
- quantização INT4 e INT8;
- servidor local persistente;
- streaming de áudio;
- saída PCM em 24 kHz;
- suporte a português.

O servidor local fica em `127.0.0.1:18742` por padrão.

## Instalação

Execute:

`npm run audio:setup`

O setup agora:

1. verifica/instala SoX;
2. baixa o backend nativo;
3. compila o executável `qwen_tts`;
4. baixa o modelo Qwen3-TTS 0.6B;
5. mantém o backend Python antigo como fallback.

Os modelos e o backend nativo ficam fora do repositório em:

`~/.local/share/jarvis/tts-native/`

## Configuração

A voz padrão do backend nativo é `ryan`.

É possível alterar sem modificar o código:

`JARVIS_TTS_NATIVE_VOICE="ryan" npm start`

O número de threads pode ser alterado com:

`JARVIS_TTS_NATIVE_THREADS=4 npm start`

A quantização pode ser alterada com:

`JARVIS_TTS_NATIVE_QUANTIZATION=int8 npm start`

Para o Ryzen 5 5600GT, o padrão é INT4 e quatro threads.

## Objetivo de latência

O objetivo desta implementação não é apenas reduzir o tempo total de síntese. O principal indicador é o tempo até o primeiro áudio.

Antes:

`resposta textual -> geração do WAV completo -> reprodução`

Agora:

`resposta textual -> streaming de áudio -> reprodução imediata enquanto a síntese continua`

O TTS não deve bloquear a resposta textual do Agent.

## Fallback

Se o backend nativo não estiver instalado ou falhar durante a execução, o Jarvis tenta usar o backend Python anterior.

O fallback existe para preservar a funcionalidade, mas o backend nativo é o caminho principal.

## Próximas otimizações

Depois de medir o backend no Ryzen 5 5600GT:

1. comparar INT4 e INT8;
2. medir tempo até primeiro áudio;
3. medir RTF;
4. ajustar número de threads;
5. verificar se o streaming permanece sem interrupções;
6. escolher definitivamente a configuração padrão.

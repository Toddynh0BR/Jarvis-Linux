# Jarvis Phase 4

## Objetivo

A Fase 4 amplia a inteligência do Jarvis sem trocar o modelo local nem colocar ferramentas no caminho de perguntas simples.

A arquitetura passa a separar quatro capacidades:

1. Inferência local com Qwen3-4B-Instruct-2507.
2. Memória persistente local em SQLite.
3. Ferramentas executáveis com chamadas estruturadas.
4. Conhecimento externo através de pesquisa web.

## Memória

O Jarvis mantém memórias persistentes na tabela memories do banco local.

Memórias podem ser recuperadas por relevância simples baseada em termos e importância. O contexto recuperado é pequeno e só é anexado quando existe correspondência, evitando aumentar desnecessariamente o prompt de todas as conversas.

Informações explicitamente apresentadas pelo usuário em padrões como "meu nome é", "eu trabalho com", "eu gosto de", "eu prefiro" e "meu projeto é" podem ser armazenadas automaticamente.

A ferramenta remember permite gravação explícita. A ferramenta forgetMemory permite remoção explícita.

Senhas, tokens, chaves privadas e dados financeiros sensíveis não devem ser armazenados.

## Pesquisa web

A ferramenta searchWeb consulta resultados públicos da internet quando o usuário pede pesquisa ou quando a pergunta depende de informação atual.

Perguntas sobre notícias, cargos atuais, eleições, preços, versões recentes, eventos recentes e fatos que mudam com o tempo são encaminhadas para essa ferramenta.

O Jarvis deve tratar os resultados como evidência externa, não como memória permanente.

## Desempenho

Perguntas simples continuam usando o caminho rápido.

A pesquisa web e as ferramentas só entram quando a rota identifica necessidade. A memória recupera no máximo um pequeno conjunto de registros relevantes.

O modelo principal continua sendo qwen3:4b-instruct.

## Próximas etapas

A próxima evolução deve melhorar a recuperação de memória, a confiabilidade das ferramentas, a verificação de fontes e o planejamento de tarefas com múltiplas ferramentas.

Fine-tuning não é necessário nesta etapa. O objetivo é aumentar a inteligência efetiva do sistema através de contexto, ferramentas e memória externa ao modelo.

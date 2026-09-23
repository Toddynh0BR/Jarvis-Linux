import { JarvisTTS } from "./tts";

async function main(): Promise<void> {
    const tts = new JarvisTTS();

    try {
        console.log("Iniciando teste de voz do Jarvis...");
        await tts.speak(
            "Olá. Eu sou o Jarvis. O meu motor de voz está sendo executado localmente neste computador."
        );
        console.log("✓ Teste de voz concluído.");
    } finally {
        await tts.stop();
    }
}

main().catch(error => {
    console.error(
        "✗ Teste de voz falhou:",
        error instanceof Error ? error.message : error
    );
    process.exit(1);
});

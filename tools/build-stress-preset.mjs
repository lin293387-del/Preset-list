// @ts-check
/**
 * Generates the benchmark sample preset.
 *
 * The A/B benchmark is only meaningful with a long prompt list, so this script
 * produces a chat-completion preset with 60 extra prompts derived from an
 * existing preset. Regenerate with:
 *
 *     node tools/build-stress-preset.mjs [path/to/preset.json]
 *
 * Without an argument it looks for the TauriTavern checkout next to this repo
 * (`../TT/default/content/presets/openai/Default.json`). The generated file is
 * committed, so running this script is only needed to rebuild the sample.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Chat-completion presets address the global prompt order with this id. */
const COMPLETION_DUMMY_CHARACTER_ID = 100001;
const EXTRA_PROMPT_COUNT = 60;
const OUTPUT_NAME = `bench-stress-${EXTRA_PROMPT_COUNT}.preset.json`;

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultSource = path.resolve(here, '../../TT/default/content/presets/openai/Default.json');
const sourcePath = path.resolve(process.argv[2] ?? defaultSource);

/**
 * @param {number} index
 * @returns {{ identifier: string, name: string, role: string, content: string }}
 */
function buildStressPrompt(index) {
    const label = String(index).padStart(2, '0');
    return {
        identifier: `stress-${label}`,
        name: `Stress Prompt ${label}`,
        role: index % 3 === 0 ? 'assistant' : 'user',
        // Long enough that token counting has real work to do, short enough to
        // stay readable in the prompt manager list.
        content: [
            `Stress prompt ${label}: keep the tone consistent with the previous scene.`,
            'Mention one sensory detail, one character action and one open question.',
            'Never repeat a sentence that already appeared in this chat.',
        ].join(' '),
    };
}

async function main() {
    let raw;
    try {
        raw = await fs.readFile(sourcePath, 'utf8');
    } catch {
        throw new Error(
            `Source preset not found: ${sourcePath}\n`
            + 'Pass the path to any chat-completion preset, for example:\n'
            + '  node tools/build-stress-preset.mjs "/path/to/TauriTavern/default/content/presets/openai/Default.json"',
        );
    }
    const preset = JSON.parse(raw);

    const prompts = preset.prompts.filter((/** @type {any} */ prompt) => prompt && !prompt.system_prompt);
    const extras = Array.from({ length: EXTRA_PROMPT_COUNT }, (_, index) => buildStressPrompt(index + 1));

    preset.name = `Bench Stress ${EXTRA_PROMPT_COUNT}`;
    preset.prompts = [...preset.prompts, ...extras];

    const order = preset.prompt_order.find(
        (/** @type {any} */ entry) => String(entry.character_id) === String(COMPLETION_DUMMY_CHARACTER_ID),
    );
    if (!order) {
        throw new Error(`Source preset has no prompt_order for character ${COMPLETION_DUMMY_CHARACTER_ID}`);
    }

    const chatHistoryIndex = order.order.findIndex((/** @type {any} */ entry) => entry.identifier === 'chatHistory');
    const insertAt = chatHistoryIndex === -1 ? order.order.length : chatHistoryIndex;
    const extraOrder = extras.map(prompt => ({ identifier: prompt.identifier, enabled: true }));
    order.order = [...order.order.slice(0, insertAt), ...extraOrder, ...order.order.slice(insertAt)];

    await fs.writeFile(path.join(here, OUTPUT_NAME), `${JSON.stringify(preset, null, 4)}\n`, 'utf8');
    console.log(`Wrote ${OUTPUT_NAME}: ${preset.prompts.length} prompts (${extras.length} generated stress prompts)`);
}

await main();

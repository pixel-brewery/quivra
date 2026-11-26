/**
 * Removes only immutable action revisions and plain version comments for comparison.
 *
 * @param text - Exact workflow text whose permission and secret contract was checked.
 * @returns Text retaining every owner, repository, action path and non-pin source byte.
 *
 * @public
 */
export function normalizeWorkflowActionPins(text: string): string {
    return text.split("\n").map((line) => {
        const match = /^([ ]*(?:-\s+)?uses:\s+)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)@([a-f0-9]{40})(?:[ ]+#\s*v?\d+(?:\.\d+)*(?:[.+-][a-zA-Z0-9_.-]+)?)?[ ]*$/u.exec(line);
        return match ? `${match[1]}${match[2]}@PIN` : line;
    }).join("\n");
}

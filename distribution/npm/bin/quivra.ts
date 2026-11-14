#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { binaryPath } from "../src/binary.ts";

function fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`quivra: ${message}`);
    process.exitCode = 1;
}

try {
    const child = spawn(binaryPath(), process.argv.slice(2), { stdio: "inherit" });
    const signals = new Map<NodeJS.Signals, () => void>([
        ["SIGINT", () => { child.kill("SIGINT"); }],
        ["SIGTERM", () => { child.kill("SIGTERM"); }],
    ]);
    for (const [signal, forward] of signals) {
        process.on(signal, forward);
    }
    child.once("error", fail);
    child.once("close", (code, signal) => {
        for (const [forwardedSignal, forward] of signals) {
            process.off(forwardedSignal, forward);
        }
        if (process.exitCode !== 1) {
            const signalNumber = signal === null ? 1 : constants.signals[signal] ?? 1;
            process.exitCode = code ?? 128 + signalNumber;
        }
    });
} catch (error) {
    fail(error);
}

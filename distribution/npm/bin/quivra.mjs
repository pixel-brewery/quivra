#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { binaryPath } from "../src/binary.mjs";

function fail(error) {
    console.error(`quivra: ${error.message}`);
    process.exitCode = 1;
}

try {
    const child = spawn(binaryPath(), process.argv.slice(2), { stdio: "inherit" });
    const signals = new Map([
        ["SIGINT", () => child.kill("SIGINT")],
        ["SIGTERM", () => child.kill("SIGTERM")],
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
            process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1);
        }
    });
} catch (error) {
    fail(error);
}

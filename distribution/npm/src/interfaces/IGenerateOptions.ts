import type { IInspectOptions } from "./IInspectOptions.js";

export interface IGenerateOptions extends IInspectOptions {
    out: string;
    check?: boolean;
}

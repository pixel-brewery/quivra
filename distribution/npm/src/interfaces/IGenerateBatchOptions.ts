export interface IGenerateBatchOptions {
    /** JSON batch manifest. Relative document paths resolve beside it. */
    batch: string;
    profile: string;
    referenceRoot?: string;
    out: string;
    check?: boolean;
}

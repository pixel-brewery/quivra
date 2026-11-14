interface IPlatform {
    readonly runner: string;
    readonly target: string;
    readonly os: "darwin" | "linux" | "win32";
    readonly cpu: "arm64" | "x64";
    readonly libc?: "glibc";
}
export const platforms: readonly IPlatform[] = [
    {
        runner: "macos-15",
        target: "aarch64-apple-darwin",
        os: "darwin",
        cpu: "arm64",
    },
    {
        runner: "macos-15-intel",
        target: "x86_64-apple-darwin",
        os: "darwin",
        cpu: "x64",
    },
    {
        runner: "ubuntu-22.04-arm",
        target: "aarch64-unknown-linux-gnu",
        os: "linux",
        cpu: "arm64",
        libc: "glibc",
    },
    {
        runner: "ubuntu-22.04",
        target: "x86_64-unknown-linux-gnu",
        os: "linux",
        cpu: "x64",
        libc: "glibc",
    },
    {
        runner: "windows-11-arm",
        target: "aarch64-pc-windows-msvc",
        os: "win32",
        cpu: "arm64",
    },
    {
        runner: "windows-2025",
        target: "x86_64-pc-windows-msvc",
        os: "win32",
        cpu: "x64",
    },
];

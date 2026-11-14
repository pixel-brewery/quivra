const abiByPlatform: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
    linux: "-gnu",
    win32: "-msvc",
};

export function binaryPackageName(launcherName: string, platform: NodeJS.Platform, arch: string): string {
    const abi = abiByPlatform[platform] ?? "";
    return `${launcherName}-${platform}-${arch}${abi}`;
}

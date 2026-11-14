const abiByPlatform = {
    linux: "-gnu",
    win32: "-msvc",
};

export function binaryPackageName(launcherName, platform, arch) {
    const abi = abiByPlatform[platform] ?? "";
    return `${launcherName}-${platform}-${arch}${abi}`;
}

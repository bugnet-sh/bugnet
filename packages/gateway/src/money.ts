// Exact to the micro, since bugnet_start and bugnet_extend accept only the exact price back
export function usd(micros: number | bigint): string {
    const m = typeof micros === "bigint" ? micros : BigInt(Math.round(micros));
    const abs = m < 0n ? -m : m;
    const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${m < 0n ? "-" : ""}$${abs / 1_000_000n}.${frac.padEnd(2, "0")}`;
}

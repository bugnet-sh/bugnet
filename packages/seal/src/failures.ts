// Codes a stored secret fails with (data-plane 6.10 and 10.12.5.4), worded like the gateway's
export const failureReasons: Readonly<Record<string, string>> = {
    PORT_443_TAKEN: "port 443 in the sandbox is taken, and secrets need it",
    SOURCE_UNKNOWN: "this sandbox cannot use secrets, and a new sandbox can",
};

// Router codes only, so free text from the route never reaches a person or a model
export function failureCode(reason: string): string {
    if (reason === "") return "";
    return /^[A-Z0-9_]{1,64}$/.test(reason) ? reason : "UNKNOWN";
}

export function failureWhy(code: string): string | undefined {
    return Object.hasOwn(failureReasons, code) ? failureReasons[code] : undefined;
}

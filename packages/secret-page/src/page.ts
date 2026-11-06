/**
 * The entry page's controller, which reads the link, shows what the user must check, and
 * seals and sends the secret.
 *
 * Every value from the route or the URL reaches the document through textContent only, so the
 * source label and the rest stay data and are never parsed as HTML.
 */
import {
    CanonicalError,
    SealError,
    chooseKey,
    presetFor,
    sealSecret,
    type PinnedKey,
    type SealingKey,
} from "@bugnet/seal";
import { RouteFailure, getLink, submitSecret, tokenFromPath, type Fetch } from "./api.ts";
import {
    failureText,
    keyProblem,
    noTokenProblem,
    pageProblem,
    sealProblem,
    type PageProblem,
} from "./errors.ts";
import {
    check,
    hostViews,
    isGitHub,
    knownNames,
    prefill,
    readHosts,
    valueNotes,
    type Draft,
    type Field,
} from "./form.ts";
import type { LinkInfo, SecretAnswer } from "./link.ts";
import { shownTime } from "./time.ts";

export interface PageEnv {
    document: Document;
    fetch: Fetch;
    pathname: string;
    now: () => Date;
    randomId: () => string;
    pinned: readonly PinnedKey[];
    development: boolean;
}

// Route reasons that belong to one field, shown beside it instead of above the button
const reasonField: Record<string, Field> = {
    name_reserved: "name",
    host_refused: "hosts",
    host_not_allowed: "hosts",
    header_refused: "headers",
    sealed_too_large: "value",
};

const fields: readonly Field[] = ["name", "value", "hosts", "headers"];

function canMask(doc: Document): boolean {
    const css = doc.defaultView?.CSS;
    return typeof css?.supports === "function" && css.supports("-webkit-text-security", "disc");
}

export async function startPage(env: PageEnv): Promise<void> {
    const doc = env.document;

    function byId<T extends HTMLElement = HTMLElement>(id: string): T {
        const el = doc.getElementById(id);
        if (!el) throw new Error(`the page has no #${id}`);
        return el as T;
    }

    const loading = byId("loading");
    const problem = byId("problem");
    const retry = byId<HTMLButtonElement>("retry");
    const checkPanel = byId("check");
    const form = byId<HTMLFormElement>("form");
    const name = byId<HTMLInputElement>("name");
    const value = byId<HTMLInputElement>("value");
    const showValue = byId<HTMLButtonElement>("show-value");
    const hosts = byId<HTMLTextAreaElement>("hosts");
    const headers = byId<HTMLInputElement>("headers");
    const sandboxUseField = byId("sandbox-use-field");
    const sandboxUse = byId<HTMLInputElement>("sandbox-use");
    const formProblem = byId("form-problem");
    const submit = byId<HTMLButtonElement>("submit");
    const status = byId("form-status");
    const done = byId("done");
    const inputs: Record<Field, HTMLInputElement | HTMLTextAreaElement> = {
        name,
        value,
        hosts,
        headers,
    };

    const submissionId = env.randomId();
    let token = "";
    let key: SealingKey | null = null;
    let busy = false;
    let retryAction: (() => void) | null = null;
    // What the page itself last filled in, which a name change may replace
    let autoHosts = "";
    let autoHeaders = "";

    byId("dev-build").hidden = !env.development;

    function setText(id: string, text: string): void {
        byId(id).textContent = text;
    }

    function setTime(id: string, date: Date | null): void {
        const el = byId(id);
        el.textContent = shownTime(date, env.now());
        if (date) el.setAttribute("datetime", date.toISOString());
    }

    function showProblem(p: PageProblem, again: (() => void) | null = null): void {
        loading.hidden = true;
        if (p.final) {
            value.value = "";
            form.hidden = true;
            checkPanel.hidden = true;
        }
        setText(
            "problem-title",
            p.final ? "This link cannot be used" : "Bugnet could not load this link",
        );
        setText("problem-text", p.message);
        setText("problem-code", p.code);
        retryAction = p.retry ? again : null;
        retry.hidden = retryAction === null;
        problem.hidden = false;
        problem.focus();
    }

    function setFieldError(field: Field, message: string): void {
        const error = byId(`${field}-error`);
        error.textContent = message;
        error.hidden = message.length === 0;
        if (message) inputs[field].setAttribute("aria-invalid", "true");
        else inputs[field].removeAttribute("aria-invalid");
    }

    function clearProblems(): void {
        for (const f of fields) setFieldError(f, "");
        formProblem.hidden = true;
    }

    function showFormProblem(p: PageProblem): void {
        const field = Object.hasOwn(reasonField, p.code) ? reasonField[p.code] : undefined;
        if (field) {
            setFieldError(field, p.message);
            inputs[field].focus();
            return;
        }
        setText("form-problem-text", p.message);
        setText("form-problem-code", p.code);
        formProblem.hidden = false;
        formProblem.focus();
    }

    function refreshHosts(): void {
        const read = readHosts(hosts.value);
        const list = byId("host-items");
        list.replaceChildren(
            ...hostViews(read.hosts).map((v) => {
                const item = doc.createElement("li");
                const host = doc.createElement("span");
                host.className = "data";
                host.textContent = v.host;
                const what = doc.createElement("span");
                if (v.service) {
                    what.textContent = `, ${v.service}`;
                } else {
                    what.className = "custom";
                    what.textContent = ", typed by you, so check the spelling";
                }
                item.append(host, what);
                return item;
            }),
        );
        byId("host-list").hidden = read.hosts.length === 0;
        const github = isGitHub(name.value.trim(), read.hosts);
        sandboxUseField.hidden = !github;
        if (!github) sandboxUse.checked = false;
    }

    function refreshValue(): void {
        const note = byId("value-note");
        const notes = valueNotes(value.value);
        note.textContent = notes.join(" ");
        note.hidden = notes.length === 0;
    }

    function onNameChange(): void {
        const preset = presetFor(name.value.trim());
        if (hosts.value.trim() === "" || hosts.value === autoHosts) {
            hosts.value = preset ? preset.hosts.join("\n") : "";
            autoHosts = hosts.value;
        }
        if (headers.value.trim() === "" || headers.value === autoHeaders) {
            headers.value = preset ? preset.headerNames.join(", ") : "";
            autoHeaders = headers.value;
        }
        refreshHosts();
    }

    function draft(): Draft {
        return {
            name: name.value,
            value: value.value,
            hosts: hosts.value,
            headers: headers.value,
            sandboxUse: sandboxUse.checked,
        };
    }

    function setBusy(on: boolean, message = ""): void {
        busy = on;
        submit.disabled = on;
        form.setAttribute("aria-busy", String(on));
        status.textContent = message;
    }

    function showDone(answer: SecretAnswer): void {
        value.value = "";
        form.hidden = true;
        const spec = answer.spec;
        let text: string;
        if (answer.state === "FAILED") {
            setText("done-title", "Secret stored, but not active");
            text =
                `Bugnet stored it, but could not set it up because ` +
                `${failureText(answer.failureReason)}. Ask your agent to check the sandbox's ` +
                "secrets.";
        } else if (spec.fetchOnly) {
            text =
                "Bugnet keeps it for downloading the sandbox's source. Code in the sandbox gets " +
                "no variable for it.";
        } else if (answer.state === "ACTIVE") {
            text =
                `It is active. Code in the sandbox reads a placeholder from ${spec.name}, which ` +
                "Bugnet's egress proxy swaps for the value only in HTTPS requests to these hosts.";
        } else {
            text =
                "Bugnet stored it and is still setting it up in the sandbox, which takes a few " +
                "seconds. Your agent can check when it is active.";
        }
        setText("done-text", text);
        setText("done-name", spec.name);
        setText("done-hosts", spec.hosts.join(", ") || "none");
        setText("done-headers", spec.headerNames.join(", "));
        byId("done-headers-line").hidden = spec.headerNames.length === 0;
        done.hidden = false;
        done.focus();
    }

    async function send(): Promise<void> {
        if (busy || !key) return;
        clearProblems();
        const checked = check(draft());
        if (!checked.ok) {
            const byField = new Map<Field, string[]>();
            for (const p of checked.problems) {
                byField.set(p.field, [...(byField.get(p.field) ?? []), p.message]);
            }
            for (const [f, messages] of byField) setFieldError(f, messages.join(" "));
            const first = fields.find((f) => byField.has(f));
            if (first) inputs[first].focus();
            return;
        }
        setShown(false);
        setBusy(true, "Sealing the secret in this browser…");
        try {
            let sealed;
            try {
                sealed = await sealSecret(checked.spec, value.value, key);
            } catch (e) {
                if (!(e instanceof SealError || e instanceof CanonicalError)) throw e;
                showFormProblem(sealProblem);
                return;
            }
            status.textContent = "Sending the sealed secret to Bugnet…";
            let answer: SecretAnswer;
            try {
                answer = await submitSecret(env.fetch, token, sealed, submissionId);
            } catch (e) {
                if (!(e instanceof RouteFailure)) throw e;
                if (e.problem.final) showProblem(e.problem);
                else showFormProblem(e.problem);
                return;
            }
            showDone(answer);
        } catch {
            showFormProblem(pageProblem);
        } finally {
            setBusy(false);
        }
    }

    // The label stays the same and aria-pressed alone says whether the value shows
    function setShown(shown: boolean): void {
        value.classList.toggle("masked", !shown);
        showValue.setAttribute("aria-pressed", String(shown));
    }

    function render(link: LinkInfo): void {
        setText("pairing-code", link.pairingCode);
        setText("source", link.sourceLabel || "unknown");
        setTime("created", link.sandboxCreatedAt);
        setTime("expires", link.expiresAt);

        const filled = prefill(link.suggested);
        name.value = filled.name;
        hosts.value = filled.hosts.join("\n");
        headers.value = filled.headerNames.join(", ");
        autoHosts = hosts.value;
        autoHeaders = headers.value;
        byId("known-names").replaceChildren(
            ...knownNames.map((n) => {
                const option = doc.createElement("option");
                option.value = n;
                return option;
            }),
        );
        refreshHosts();
        refreshValue();

        loading.hidden = true;
        problem.hidden = true;
        checkPanel.hidden = false;
        form.hidden = false;
    }

    async function load(): Promise<void> {
        problem.hidden = true;
        loading.hidden = false;
        let link: LinkInfo;
        try {
            link = await getLink(env.fetch, token);
        } catch (e) {
            if (!(e instanceof RouteFailure)) throw e;
            showProblem(e.problem, () => void load());
            return;
        }
        try {
            key = chooseKey(link.sealingKeys, env.pinned);
        } catch (e) {
            if (!(e instanceof SealError)) throw e;
            showProblem(keyProblem);
            return;
        }
        render(link);
    }

    name.addEventListener("input", onNameChange);
    hosts.addEventListener("input", refreshHosts);
    value.addEventListener("input", refreshValue);
    showValue.addEventListener("click", () => setShown(value.classList.contains("masked")));
    // Where CSS cannot mask the field it always shows, so a Show button would mislead
    showValue.hidden = !canMask(doc);
    retry.addEventListener("click", () => retryAction?.());
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        void send();
    });

    const fromPath = tokenFromPath(env.pathname);
    if (!fromPath) {
        showProblem(noTokenProblem);
        return;
    }
    token = fromPath;
    await load();
}

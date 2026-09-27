import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const NON_SERIALIZABLE_RUN_ARGUMENT = "Run argument is not JSON-serializable; pass plain data";

/** Marker that renders a serialized function as an executable run argument. */
export interface FnArgMarker {
	__omp_fn: string;
}

/** Marker that renders a serialized regular expression as an executable run argument. */
export interface RegExpArgMarker {
	__omp_re: {
		source: string;
		flags?: string;
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasSoleOwnKey(value: Record<string, unknown>, key: string): boolean {
	const keys = Reflect.ownKeys(value);
	return keys.length === 1 && keys[0] === key;
}

/** `new RegExp(…)` source for a {@link RegExpArgMarker}; undefined for anything else. */
function renderRegExpMarker(value: unknown): string | undefined {
	if (!isPlainObject(value) || !hasSoleOwnKey(value, "__omp_re")) return undefined;
	const marker = value.__omp_re;
	if (
		!isPlainObject(marker) ||
		typeof marker.source !== "string" ||
		(marker.flags !== undefined && typeof marker.flags !== "string")
	) {
		return undefined;
	}
	return `new RegExp(${JSON.stringify(marker.source)}, ${JSON.stringify(marker.flags ?? "")})`;
}

/**
 * Renders one host value as a JavaScript argument for an evaluated run.
 * A top-level function marker renders as code; RegExp markers render as
 * `new RegExp(…)` at any depth (option objects such as `{ until: { url: /x/ } }`).
 */
export function renderRunArg(value: unknown): string {
	if (value === undefined) return "undefined";

	if (isPlainObject(value) && hasSoleOwnKey(value, "__omp_fn") && typeof value.__omp_fn === "string") {
		return `(${value.__omp_fn})`;
	}

	const topLevel = renderRegExpMarker(value);
	if (topLevel !== undefined) return topLevel;

	// Nested markers become unguessable placeholder strings, swapped for code after
	// serialization, so everything else keeps exact JSON.stringify semantics.
	let placeholder: string | undefined;
	const nested: string[] = [];
	let rendered: string | undefined;
	try {
		rendered = JSON.stringify(value, (_key, item: unknown) => {
			const regexp = renderRegExpMarker(item);
			if (regexp === undefined) return item;
			placeholder ??= `__omp_re_${crypto.randomUUID()}_`;
			nested.push(regexp);
			return `${placeholder}${nested.length - 1}`;
		});
	} catch {
		throw new ToolError(NON_SERIALIZABLE_RUN_ARGUMENT);
	}
	if (rendered === undefined) throw new ToolError(NON_SERIALIZABLE_RUN_ARGUMENT);
	if (placeholder === undefined) return rendered;
	return rendered.replace(
		new RegExp(`"${placeholder}(\\d+)"`, "g"),
		(_match, index: string) => nested[Number(index)]!,
	);
}

/** Renders a helper call chain (`id(5).click()`) with arguments as JavaScript literals. */
export function renderCallChain(chain: readonly { method: string; args: readonly unknown[] }[]): string {
	return chain.map(step => `${step.method}(${step.args.map(renderRunArg).join(", ")})`).join(".");
}

/** Renders a function invocation with the requested run scope and positional arguments. */
export function renderFunctionRun(fnSource: string, scopeNames: readonly string[], args: readonly unknown[]): string {
	const scope = scopeNames.join(", ");
	const renderedArgs = args.map(value => `, ${renderRunArg(value)}`).join("");
	return `return await (${fnSource})({ ${scope} }${renderedArgs});`;
}

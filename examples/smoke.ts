import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IFetchOptions } from "./generated/fetch/client.ts";
import type { ITransport } from "./generated/transport/interfaces/ITransport.ts";
import type { ITransportRequest } from "./generated/transport/interfaces/ITransportRequest.ts";

const generated = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]) + "/")
    : new URL("./generated/", import.meta.url);
const fetchClient: typeof import("./generated/fetch/client.ts") = await import(
    new URL("fetch/client.ts", generated).href
);
const { WidgetClient }: typeof import("./generated/transport/client.ts") = await import(
    new URL("transport/client.ts", generated).href
);
const { routes }: typeof import("./generated/transport/routes.ts") = await import(
    new URL("transport/routes.ts", generated).href
);

const widget = { id: "red/1", name: "Red widget" };
const widgetId = { path: { "widget-id": widget.id } };
const queued = { jobId: "job-4", status: "queued" };
const list = { query: { search: "red widget", "in-stock": false } };
const create = { body: { name: widget.name, description: null } };
const events = [
    { data: "red\nwidget 🎨", event: "update", id: "42" },
    { data: "", event: "message", id: "42" },
];

function sortQuery(path: string): string {
    const boundary = path.indexOf("?");
    if (boundary < 0) return path;
    const pathname = path.slice(0, boundary);
    const query = new URLSearchParams(path.slice(boundary + 1));
    query.sort();
    return pathname + "?" + query;
}

async function collectEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const received: T[] = [];
    for await (const event of stream) received.push(event);
    return received;
}

function sseResponse(): Response {
    const bytes = new TextEncoder().encode(
        ": heartbeat\r\nid: 42\r\nevent: update\rdata: red\rdata: widget 🎨\r\n\r\ndata\n\ndata: unfinished",
    );
    let index = 0;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
            if (index === bytes.length) return controller.close();
            controller.enqueue(bytes.subarray(index, ++index));
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

const fetchRequests: Array<RequestInit & { url: string; headers: Headers }> = [];
const fetchOptions: IFetchOptions = {
    baseUrl: "https://example.test/api/",
    fetch: async (input, options) => {
        assert.equal(typeof input, "string");
        assert.ok(options);
        const url = String(input);
        const headers = new Headers(options.headers);
        fetchRequests.push({ ...options, url: sortQuery(url), headers });
        if (options.method === "DELETE" || url.endsWith("/hidden")) {
            return new Response(null, { status: 204 });
        }
        if (options.method === "POST") {
            return headers.has("authorization")
                ? Response.json(widget, { status: 201 })
                : Response.json(queued, { status: 202 });
        }
        if (url.endsWith("/widgets/events")) return sseResponse();
        return Response.json(new URL(url).pathname.endsWith("/widgets") ? [widget] : widget);
    },
};

assert.deepEqual(await fetchClient.listWidgets(fetchOptions, list), [widget]);
assert.deepEqual(await fetchClient.listWidgets(fetchOptions, { query: {} }), [widget]);
assert.deepEqual(await fetchClient.getWidget(fetchOptions, widgetId), widget);
assert.equal(await fetchClient.getWidget(fetchOptions, { path: { "widget-id": "hidden" } }), undefined);
assert.equal(await fetchClient.deleteWidget(fetchOptions, widgetId), undefined);
assert.deepEqual(await fetchClient.createWidget({ ...fetchOptions, credentials: { bearer: "my-token" } }, create), widget);
assert.deepEqual(await fetchClient.createWidget({
    ...fetchOptions,
    credentials: { tenantKey: "tenant", queryKey: "a & b" },
}, create), queued);
assert.deepEqual(await collectEvents(await fetchClient.streamWidgets(fetchOptions)), events);
assert.deepEqual(fetchRequests.map(({ url, method }) => ({ url, method })), [
    { url: "https://example.test/api/widgets?in-stock=false&search=red+widget", method: "GET" },
    { url: "https://example.test/api/widgets", method: "GET" },
    { url: "https://example.test/api/widgets/red%2F1", method: "GET" },
    { url: "https://example.test/api/widgets/hidden", method: "GET" },
    { url: "https://example.test/api/widgets/red%2F1", method: "DELETE" },
    { url: "https://example.test/api/widgets", method: "POST" },
    { url: "https://example.test/api/widgets?access_key=a+%26+b", method: "POST" },
    { url: "https://example.test/api/widgets/events", method: "GET" },
]);
const [bearerRequest, keyRequest, streamRequest] = fetchRequests.slice(5);
assert.ok(bearerRequest && keyRequest && streamRequest);
assert.equal(bearerRequest.headers.get("authorization"), "Bearer my-token");
assert.equal(bearerRequest.headers.get("content-type"), "application/json");
assert.equal(bearerRequest.redirect, "error");
assert.equal(bearerRequest.body, JSON.stringify(create.body));
assert.equal(keyRequest.headers.get("x-tenant-key"), "tenant");
assert.equal(streamRequest.headers.get("accept"), "text/event-stream");
await assert.rejects(fetchClient.createWidget(fetchOptions, create), /Missing credentials/);
await assert.rejects(fetchClient.createWidget({ ...fetchOptions, credentials: { tenantKey: "partial" } }, create), /Missing credentials/);
await assert.rejects(fetchClient.getWidget(fetchOptions, { path: { "widget-id": ".." } }), /dot segment/);
assert.equal(fetchRequests.length, 8, "invalid input must avoid HTTP");
await assert.rejects(fetchClient.getWidget({
    ...fetchOptions,
    fetch: async () => new Response(null, { status: 404 }),
}, widgetId), /HTTP 404/);
await assert.rejects(fetchClient.getWidget({
    ...fetchOptions,
    fetch: async () => new Response(null, { status: 205 }),
}, widgetId), /HTTP 205/);

const transportRequests: ITransportRequest[] = [];
const transport: ITransport = {
    async request(request) {
        transportRequests.push(request);
        if (request.method === "DELETE" || request.path.endsWith("/hidden")) {
            return { status: 204, json() { throw new Error("unexpected JSON read"); } };
        }
        if (request.path === "/widgets/events") {
            return {
                status: 200,
                json() { throw new Error("unexpected JSON read"); },
                async *events() { yield* events; },
            };
        }
        if (request.method === "POST") {
            return request.headers.has("authorization")
                ? { status: 201, async json() { return widget; } }
                : { status: 202, async json() { return queued; } };
        }
        return {
            status: 200,
            async json() { return request.path.split("?")[0] === "/widgets" ? [widget] : widget; },
        };
    },
};
const client = new WidgetClient(transport, { bearer: "my-token" });
const keyClient = new WidgetClient(transport, { tenantKey: "tenant", queryKey: "a & b" });

assert.deepEqual(await client.listWidgets(list), [widget]);
assert.deepEqual(await client.getWidget(widgetId), widget);
assert.equal(await client.getWidget({ path: { "widget-id": "hidden" } }), undefined);
assert.equal(await client.deleteWidget(widgetId), undefined);
assert.deepEqual(await client.createWidget(create), widget);
assert.deepEqual(await keyClient.createWidget(create), queued);
assert.deepEqual(await collectEvents(await client.streamWidgets()), events);
assert.deepEqual(transportRequests.map(({ path, method }) => ({ path: sortQuery(path), method })), [
    { method: "GET", path: "/widgets?in-stock=false&search=red+widget" },
    { method: "GET", path: "/widgets/red%2F1" },
    { method: "GET", path: "/widgets/hidden" },
    { method: "DELETE", path: "/widgets/red%2F1" },
    { method: "POST", path: "/widgets" },
    { method: "POST", path: "/widgets?access_key=a+%26+b" },
    { method: "GET", path: "/widgets/events" },
]);
const [bearerTransportRequest, keyTransportRequest] = transportRequests.slice(4);
assert.ok(bearerTransportRequest && keyTransportRequest);
assert.deepEqual(bearerTransportRequest.body, create.body);
assert.equal(bearerTransportRequest.headers.get("authorization"), "Bearer my-token");
assert.equal(keyTransportRequest.headers.get("x-tenant-key"), "tenant");
assert.deepEqual(routes.streamWidgets, { method: "GET", path: "/widgets/events", category: "live" });
await assert.rejects(new WidgetClient(transport).createWidget(create), /Missing credentials/);

console.log("Both profiles passed the Widget API smoke checks, including auth, status dispatch and SSE.");

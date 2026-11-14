import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const generated = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]) + "/")
    : new URL("./generated/", import.meta.url);
const fetchClient = await import(new URL("fetch/client.ts", generated));
const { WidgetClient } = await import(new URL("transport/client.ts", generated));
const { routes } = await import(new URL("transport/routes.ts", generated));

const widget = { id: "red/1", name: "Red widget" };
const widgetId = { path: { "widget-id": widget.id } };
const list = { query: { search: "red widget", "in-stock": false } };
const body = { name: widget.name };
const listPath = "/widgets?in-stock=false&search=red+widget";

function sortQuery(path) {
    const [pathname, rawQuery] = path.split("?");
    if (rawQuery === undefined) {
        return pathname;
    }
    const query = new URLSearchParams(rawQuery);
    query.sort();
    return pathname + "?" + query;
}

const fetchRequests = [];
const fetchOptions = {
    baseUrl: "https://example.test/api/",
    fetch: async (url, options) => {
        fetchRequests.push({ url, ...options });
        if (options.method === "DELETE") {
            return new Response(null, { status: 204 });
        }
        if (options.method === "POST") {
            return Response.json(widget, { status: 201 });
        }
        return Response.json(new URL(url).pathname.endsWith("/widgets") ? [widget] : widget);
    },
};

assert.deepEqual(await fetchClient.listWidgets(fetchOptions, list), [widget]);
assert.deepEqual(await fetchClient.listWidgets(fetchOptions, { query: {} }), [widget]);
assert.deepEqual(await fetchClient.getWidget(fetchOptions, widgetId), widget);
assert.deepEqual(await fetchClient.createWidget(fetchOptions, { body }), widget);
assert.equal(await fetchClient.deleteWidget(fetchOptions, widgetId), undefined);
assert.deepEqual(fetchRequests.map(({ url, ...request }) => ({ url: sortQuery(url), ...request })), [
    { url: "https://example.test/api" + listPath, method: "GET" },
    { url: "https://example.test/api/widgets", method: "GET" },
    { url: "https://example.test/api/widgets/red%2F1", method: "GET" },
    {
        url: "https://example.test/api/widgets",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    },
    { url: "https://example.test/api/widgets/red%2F1", method: "DELETE" },
]);
await assert.rejects(fetchClient.getWidget({
    ...fetchOptions,
    fetch: async () => new Response(null, { status: 404 }),
}, widgetId), /HTTP 404/);

const transportRequests = [];
const client = new WidgetClient({
    async request(request) {
        transportRequests.push(request);
        if (request.method === "DELETE") {
            return undefined;
        }
        if (request.method === "GET" && request.path.split("?")[0] === "/widgets") {
            return [widget];
        }
        return widget;
    },
});

assert.deepEqual(await client.listWidgets(list), [widget]);
assert.deepEqual(await client.listWidgets({ query: {} }), [widget]);
assert.deepEqual(await client.getWidget(widgetId), widget);
assert.deepEqual(await client.createWidget({ body }), widget);
assert.equal(await client.deleteWidget(widgetId), undefined);
assert.deepEqual(transportRequests.map(({ path, ...request }) => ({ path: sortQuery(path), ...request })), [
    { method: "GET", path: listPath },
    { method: "GET", path: "/widgets" },
    { method: "GET", path: "/widgets/red%2F1" },
    { method: "POST", path: "/widgets", body },
    { method: "DELETE", path: "/widgets/red%2F1" },
]);
assert.deepEqual(routes.getWidget, { method: "GET", path: "/widgets/{widget-id}" });

console.log("Fetch and transport clients passed the same Widget API smoke checks.");

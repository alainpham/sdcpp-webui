import type { Capabilities, Job, Recipe, ModelFile, ModelStatus, CatalogError, HistoryImage, SettingsPreset, WebUiSettings } from "./types";

function withBase(baseUrl: string, path: string): string {
    const base = String(baseUrl || window.location.pathname).trim().replace(/\/+$/, "");
    return `${base}${path}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    let payload: any = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }
    if (!response.ok) {
        throw new Error(
            (payload && (payload.error || payload.message)) || `HTTP ${response.status}`
        );
    }
    return payload as T;
}

export function getCapabilities(baseUrl: string): Promise<Capabilities> {
    return fetchJson<Capabilities>(withBase(baseUrl, "/sdcpp/v1/capabilities"));
}

export function getWebUiSettings(baseUrl: string): Promise<WebUiSettings> {
    return fetchJson<WebUiSettings>(withBase(baseUrl, "/sdcpp/v1/settings"));
}

export function saveWebUiSettings(baseUrl: string, settings: WebUiSettings): Promise<{ saved: boolean }> {
    return fetchJson<{ saved: boolean }>(withBase(baseUrl, "/sdcpp/v1/settings"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(settings),
    });
}

export function getSettingsPresets(baseUrl: string): Promise<{ presets: SettingsPreset[] }> {
    return fetchJson<{ presets: SettingsPreset[] }>(withBase(baseUrl, "/sdcpp/v1/settings/presets"));
}

export function saveSettingsPreset(baseUrl: string, name: string, settings: WebUiSettings): Promise<{ saved: boolean; name: string }> {
    return fetchJson<{ saved: boolean; name: string }>(withBase(baseUrl, "/sdcpp/v1/settings/presets"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, settings }),
    });
}

export function getImageHistory(baseUrl: string): Promise<{ images: HistoryImage[] }> {
    return fetchJson<{ images: HistoryImage[] }>(withBase(baseUrl, "/sdcpp/v1/history"));
}

export function deleteHistoryImage(baseUrl: string, filename: string): Promise<{ deleted: boolean }> {
    return fetchJson<{ deleted: boolean }>(withBase(baseUrl, `/sdcpp/v1/history/${encodeURIComponent(filename)}`), {
        method: "DELETE",
    });
}

export function imageHistoryUrl(baseUrl: string, filename: string, thumbnail = false): string {
    const path = `/sdcpp/v1/history/${encodeURIComponent(filename)}`;
    return withBase(baseUrl, `${path}${thumbnail ? "?thumbnail=1" : ""}`);
}

export function getHistorySettings(baseUrl: string, filename: string): Promise<WebUiSettings> {
    const stem = filename.replace(/\.png$/i, "");
    return fetchJson<WebUiSettings>(withBase(baseUrl, `/sdcpp/v1/history/${encodeURIComponent(stem)}/settings`));
}

export function submitImageJob(baseUrl: string, body: unknown): Promise<Job> {
    return fetchJson<Job>(withBase(baseUrl, "/sdcpp/v1/img_gen"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

export function submitVideoJob(baseUrl: string, body: unknown): Promise<Job> {
    return fetchJson<Job>(withBase(baseUrl, "/sdcpp/v1/vid_gen"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

export function getJob(baseUrl: string, id: string): Promise<Job> {
    return fetchJson<Job>(withBase(baseUrl, `/sdcpp/v1/jobs/${id}`), { cache: "no-store" });
}

export function cancelJob(baseUrl: string, id: string): Promise<Job> {
    return fetchJson<Job>(withBase(baseUrl, `/sdcpp/v1/jobs/${id}/cancel`), {
        method: "POST",
    });
}

export function getRecipes(baseUrl: string): Promise<{ recipes: Recipe[]; errors: CatalogError[] }> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/recipes"));
}
export function getModelFiles(baseUrl: string): Promise<{ files: ModelFile[]; errors: CatalogError[] }> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/model-files"));
}
export function getModelStatus(baseUrl: string): Promise<ModelStatus> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/status"));
}
export function refreshModels(baseUrl: string): Promise<{ errors: CatalogError[] }> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/refresh"), { method: "POST" });
}
export function loadModel(baseUrl: string, recipe: string, models: Record<string, string>): Promise<ModelStatus> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/load"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe, models }),
    });
}
export function unloadModel(baseUrl: string): Promise<ModelStatus> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/unload"), { method: "POST" });
}

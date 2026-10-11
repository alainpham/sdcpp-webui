<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import CollapsibleSection from "./components/CollapsibleSection.vue";
import ImageDropzone from "./components/ImageDropzone.vue";
import StatusChip from "./components/StatusChip.vue";
import {
    cancelJob,
    getCapabilities,
    getJob,
    getHistorySettings,
    getImageHistory,
    getSettingsPresets,
    getWebUiSettings,
    deleteHistoryImage as deleteHistoryImageRequest,
    imageHistoryUrl,
    saveWebUiSettings,
    saveSettingsPreset as saveSettingsPresetRequest,
    submitImageJob,
    submitVideoJob,
} from "./lib/api";
import { buildRequestBodyForMode, CACHE_MODES, createBlankForm, formFromCapabilities } from "./lib/form";
import { IMAGE_INPUTS, VIDEO_IMAGE_INPUTS } from "./lib/image-inputs";
import { assignImageEntries, clearImageEntries, filesToImageEntries, removeImageEntry } from "./lib/images";
import { createStoredRef, normalizePollIntervalMs } from "./lib/settings";
import type {
    Capabilities,
    GenerationForm,
    GenerationMode,
    HistoryImage,
    ImageEntry,
    ImageTarget,
    Job,
    SampleParams,
    SettingsPreset,
    WebUiSettings,
} from "./lib/types";

const baseUrl = createStoredRef<string>("sdcpp-webui-base-url", "", (value: unknown) => String(value || ""));
const pollIntervalMs = createStoredRef<number>("sdcpp-webui-poll-interval-ms", 100, normalizePollIntervalMs);
const activeTab = ref<"image" | "video" | "settings">("image");
const selectedGenerationTab = ref<"image" | "video">("image");
const generationMode = computed<GenerationMode>(() => selectedGenerationTab.value === "video" ? "video" : "image");
const lightboxOpen = ref(false);
const lightboxImageSrc = ref("");
const lightboxImageAlt = ref("");
const historyLightboxOpen = ref(false);
const sectionState = reactive<Record<string, boolean>>({
    sample: true,
    sampleAdvanced: false,
    guidance: true,
    guidanceAdvanced: false,
    highNoise: false,
    highNoiseSample: true,
    highNoiseGuidance: true,
    conditioning: false,
    auxiliaryImages: false,
    lora: false,
    vaeTiling: false,
    preview: false,
    cache: false,
});
const loadingCapabilities = ref(false);
const capabilitiesError = ref("");
const serviceOnline = ref(false);
const capabilities = ref<Capabilities | null>(null);
const currentJob = ref<Job | null>(null);
const settingsError = ref("");
const savingDefaultSettings = ref(false);
const settingsPresets = ref<SettingsPreset[]>([]);
const selectedPresetName = ref("");
const presetName = ref("");
const presetError = ref("");
const presetStatus = ref("");
const historyImages = ref<HistoryImage[]>([]);
const selectedHistoryIndex = ref(-1);
const historyLoading = ref(false);
const historyLightboxDeleteLoading = ref(false);
const historyError = ref("");
const historyImageSettings = ref<WebUiSettings | null>(null);
const historySettingsLoading = ref(false);
const historySettingsError = ref("");
const historyLoadFeedback = ref("");
const historyDetailsVisible = ref(false);
const selectedOutputIndex = ref(0);
const statusMessage = ref("");
const statusTone = ref("");
const form = reactive<GenerationForm>(createBlankForm());

let pollTimer = 0;
let elapsedTimer = 0;
let formInitialized = false;
let historySettingsRequestId = 0;
let historyRevision = 0;
const pendingHistoryDeletes = new Set<string>();
const nowSeconds = ref(Date.now() / 1000);

const modelName = computed(() => {
    const model = capabilities.value?.model;
    return model?.stem || model?.name || "No model info";
});

const supportedModes = computed(() => capabilities.value?.supported_modes || []);
const supportsImageMode = computed(() => {
    return !supportedModes.value.length || supportedModes.value.includes("img_gen");
});
const supportsVideoMode = computed(() => {
    return !supportedModes.value.length || supportedModes.value.includes("vid_gen");
});
const selectedModeKey = computed<"img_gen" | "vid_gen">(() => generationMode.value === "video" ? "vid_gen" : "img_gen");
const currentJobModeKey = computed<"img_gen" | "vid_gen">(() => currentJob.value?.kind || selectedModeKey.value);
const selectedModeFeatures = computed(() => {
    return capabilities.value?.features_by_mode?.[selectedModeKey.value] || {};
});
const currentJobFeatures = computed(() => {
    return capabilities.value?.features_by_mode?.[currentJobModeKey.value] || selectedModeFeatures.value;
});
const imageOutputFormats = computed(() => {
    return capabilities.value?.output_formats_by_mode?.img_gen || ["png", "jpeg"];
});
const videoOutputFormats = computed(() => {
    return capabilities.value?.output_formats_by_mode?.vid_gen || ["webm", "avi"];
});
const outputFormats = computed(() => generationMode.value === "video" ? videoOutputFormats.value : imageOutputFormats.value);
const samplers = computed(() => capabilities.value?.samplers || ["default"]);
const schedulers = computed(() => capabilities.value?.schedulers || ["default"]);
const availableLoras = computed(() => capabilities.value?.loras || []);
const currentImageInputs = computed(() => generationMode.value === "video" ? VIDEO_IMAGE_INPUTS : IMAGE_INPUTS);
const gridImageInputs = computed(() => currentImageInputs.value.filter((input) => input.layout === "grid"));
const fullImageInputs = computed(() => currentImageInputs.value.filter((input) => input.layout === "full"));
const queueLimit = computed(() => capabilities.value?.limits?.max_queue_size ?? "unknown");
const canCancelQueued = computed(() => Boolean(currentJobFeatures.value.cancel_queued));
const canCancelGenerating = computed(() => Boolean(currentJobFeatures.value.cancel_generating));
const supportsPreview = computed(() => Boolean(currentJobFeatures.value.preview));
const previewModes = computed(() => capabilities.value?.preview_modes || ["none", "proj", "tae", "vae"]);

const currentStatus = computed(() => currentJob.value?.status || "idle");
const currentJobKind = computed(() => currentJob.value?.kind || null);
const currentImages = computed(() => currentJobKind.value === "img_gen" ? currentJob.value?.result?.images || [] : []);
const selectedHistoryImage = computed(() => historyImages.value[selectedHistoryIndex.value] || null);
const historyImageSrc = computed(() => selectedHistoryImage.value
    ? imageHistoryUrl(baseUrl.value, selectedHistoryImage.value.filename)
    : null);
const historyImageDetails = computed(() => {
    const savedForm = historyImageSettings.value?.form;
    const sample = savedForm?.sample_params;
    return {
        cfgScale: sample?.guidance?.txt_cfg ?? "—",
        steps: sample?.sample_steps ?? "—",
        scheduler: sample?.scheduler || "—",
        method: sample?.sample_method || "—",
        seed: savedForm?.seed ?? "—",
    };
});
const selectedImage = computed(() => {
    if (!currentImages.value.length) {
        return null;
    }
    const index = Math.min(selectedOutputIndex.value, currentImages.value.length - 1);
    const image = currentImages.value[index];
    const format = currentJob.value?.result?.output_format || form.output_format || "png";
    return `data:image/${format};base64,${image.b64_json}`;
});
const videoMimeType = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.mime_type || "" : "");
const videoFrameCount = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.frame_count || 0 : 0);
const videoFps = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.fps || 0 : 0);
const videoPreviewSrc = computed(() => {
    if (currentJobKind.value !== "vid_gen" || !currentJob.value?.result?.b64_json) {
        return null;
    }
    if (currentJob.value?.result?.output_format === "avi") {
        return null;
    }
    if (!videoMimeType.value.startsWith("video/")) {
        return null;
    }
    return `data:${videoMimeType.value};base64,${currentJob.value.result.b64_json}`;
});
const animatedVideoImageSrc = computed(() => {
    if (currentJobKind.value !== "vid_gen" || !currentJob.value?.result?.b64_json) {
        return null;
    }
    if (videoMimeType.value !== "image/webp") {
        return null;
    }
    return `data:image/webp;base64,${currentJob.value.result.b64_json}`;
});
const previewImageSrc = computed(() => animatedVideoImageSrc.value || selectedImage.value);
const livePreviewSrc = computed(() => {
    if (currentStatus.value !== "generating" || !currentJob.value?.preview?.b64_json) {
        return null;
    }
    return `data:image/png;base64,${currentJob.value.preview.b64_json}`;
});
const livePreviewPass = computed(() => currentJob.value?.preview?.pass ?? 1);
const livePreviewStep = computed(() => currentJob.value?.preview?.step ?? 0);
const livePreviewTotalSteps = computed(() => currentJob.value?.preview?.total_steps ?? 0);
const downloadableSrc = computed(() => {
    if (historyLightboxOpen.value) {
        return historyImageSrc.value;
    }
    const result = currentJob.value?.result;
    if (currentJobKind.value === "vid_gen" && result?.b64_json && videoMimeType.value) {
        return `data:${videoMimeType.value};base64,${result.b64_json}`;
    }
    return selectedImage.value;
});

const canCancelCurrentJob = computed(() => {
    if (!currentJob.value) {
        return false;
    }
    if (currentStatus.value === "queued") {
        return canCancelQueued.value;
    }
    if (currentStatus.value === "generating") {
        return canCancelGenerating.value;
    }
    return false;
});

const isJobRunning = computed(() => {
    return currentStatus.value === "queued" || currentStatus.value === "generating";
});

function buildSampleSummary(sample: SampleParams): string {
    const scheduler = sample.scheduler || "default";
    const method = sample.sample_method || "default";
    const steps = sample.sample_steps || 0;
    const schedule = String(sample.custom_sigmas || "").trim() ? "custom sigmas" : scheduler;
    const flowShift = sample.flow_shift === "" || sample.flow_shift == null
        ? "flow auto"
        : `flow ${sample.flow_shift}`;
    return `${schedule} · ${flowShift} · ${method} · ${steps} steps`;
}

function buildGuidanceSummary(sample: SampleParams): string {
    const cfg = sample.guidance.txt_cfg;
    const distilled = sample.guidance.distilled_guidance;
    return `cfg ${cfg} · distilled ${distilled}`;
}

const sampleSummary = computed(() => buildSampleSummary(form.sample_params));
const guidanceSummary = computed(() => buildGuidanceSummary(form.sample_params));
const highNoiseSummary = computed(() => {
    return `moe ${formatSummaryNumber(form.moe_boundary)} · ${buildSampleSummary(form.high_noise_sample_params)} · ${buildGuidanceSummary(form.high_noise_sample_params)}`;
});
const loraSummary = computed(() => {
    if (!form.lora.length) {
        return "No LoRA";
    }
    return `${form.lora.length} configured`;
});
const imageInputsSummary = computed(() => {
    const parts: string[] = [];
    if (form.init_image) parts.push(generationMode.value === "video" ? "start" : "init");
    if (generationMode.value === "image") {
        if (form.mask_image) parts.push("mask");
        if (form.control_image) parts.push("control");
        if (form.ref_images.length) parts.push(`${form.ref_images.length} refs`);
    } else {
        if (form.end_image) parts.push("end");
        if (form.ref_images.length) parts.push(`${form.ref_images.length} refs`);
        if (form.control_frames.length) parts.push(`${form.control_frames.length} frames`);
    }
    return parts.length ? parts.join(" · ") : "No images";
});
const vaeTilingSummary = computed(() => {
    if (!form.vae_tiling_params.enabled) {
        return "Disabled";
    }
    return `${form.vae_tiling_params.tile_size_w}×${form.vae_tiling_params.tile_size_h} · overlap ${form.vae_tiling_params.target_overlap}`;
});
const cacheSummary = computed(() => {
    const mode = form.cache.mode || "disabled";
    if (mode === "disabled") {
        return "Disabled";
    }
    const option = String(form.cache.option || "").trim();
    return option ? `${mode} · ${option}` : mode;
});
const conditioningSummary = computed(() => {
    const clipSkip = formatSummaryNumber(form.clip_skip, 0);
    const strength = formatSummaryNumber(form.strength);
    if (generationMode.value === "video") {
        return `clip_skip ${clipSkip} · strength ${strength} · vace ${formatSummaryNumber(form.vace_strength)}`;
    }
    const controlStrength = formatSummaryNumber(form.control_strength);
    return `clip_skip ${clipSkip} · img ${strength} · control ${controlStrength}`;
});

function defaultOutputFormatForMode(mode: GenerationMode): string {
    if (mode === "video") {
        return videoOutputFormats.value[0] || "webm";
    }
    return imageOutputFormats.value[0] || "png";
}

function ensureOutputFormatForMode(mode = generationMode.value): void {
    const validFormats = mode === "video" ? videoOutputFormats.value : imageOutputFormats.value;
    if (!validFormats.length) {
        return;
    }
    if (!validFormats.includes(form.output_format)) {
        form.output_format = defaultOutputFormatForMode(mode);
    }
}

function setMessage(message: string, tone = ""): void {
    statusMessage.value = message;
    statusTone.value = tone;
}

function clearMessage(): void {
    setMessage("", "");
}

function deepAssign(target: Record<string, any>, ...sources: Record<string, any>[]): Record<string, any> {
    for (const source of sources) {
        if (!source) continue;
        for (const key of Object.keys(source)) {
            const sv = source[key];
            if (sv !== null && typeof sv === "object" && !Array.isArray(sv) &&
                target[key] !== null && typeof target[key] === "object" && !Array.isArray(target[key])) {
                deepAssign(target[key], sv);
            } else {
                target[key] = sv;
            }
        }
    }
    return target;
}

function applyForm(nextForm: Partial<GenerationForm>, reset = false): void {
    if (reset) {
        deepAssign(form, createBlankForm(), nextForm);
        return;
    }
    deepAssign(form, nextForm);
}

function normalizeCustomSigmas(value: unknown): string {
    if (Array.isArray(value)) {
        return value.join(", ");
    }
    return typeof value === "string" ? value.trim() : "";
}

function currentWebUiSettings(): WebUiSettings {
    const savedForm = {
        ...form,
        init_image: undefined,
        end_image: undefined,
        ref_images: undefined,
        control_frames: undefined,
        mask_image: undefined,
        control_image: undefined,
    };
    return {
        form: JSON.parse(JSON.stringify(savedForm)) as Partial<GenerationForm>,
        generation_mode: selectedGenerationTab.value,
    };
}

function applyWebUiSettings(settings: WebUiSettings): void {
    applyForm({
        ...settings.form,
        sample_params: {
            ...settings.form.sample_params,
            custom_sigmas: normalizeCustomSigmas(settings.form.sample_params?.custom_sigmas),
        },
        high_noise_sample_params: {
            ...settings.form.high_noise_sample_params,
            custom_sigmas: normalizeCustomSigmas(settings.form.high_noise_sample_params?.custom_sigmas),
        },
        init_image: null,
        end_image: null,
        ref_images: [],
        control_frames: [],
        mask_image: null,
        control_image: null,
    });

    const requestedMode = settings.generation_mode;
    let appliedMode: GenerationMode;
    if (requestedMode === "image" && supportsImageMode.value) {
        appliedMode = "image";
    } else if (requestedMode === "video" && supportsVideoMode.value) {
        appliedMode = "video";
    } else {
        appliedMode = supportsVideoMode.value ? "video" : "image";
    }
    selectedGenerationTab.value = appliedMode;
    if (activeTab.value !== "settings") {
        activeTab.value = appliedMode;
    }
    ensureOutputFormatForMode();
}

async function refreshSettingsPresets(): Promise<void> {
    try {
        const response = await getSettingsPresets(baseUrl.value);
        const currentSelection = selectedPresetName.value;
        settingsPresets.value = response.presets || [];
        if (settingsPresets.value.some((preset) => preset.name === currentSelection)) {
            selectedPresetName.value = currentSelection;
        } else {
            selectedPresetName.value = settingsPresets.value[0]?.name || "";
        }
        presetError.value = "";
    } catch (error) {
        presetError.value = error instanceof Error ? error.message : String(error);
    }
}

async function saveCurrentPreset(): Promise<void> {
    const name = presetName.value.trim();
    if (!name) {
        presetError.value = "Enter a name for this preset.";
        return;
    }
    try {
        await saveSettingsPresetRequest(baseUrl.value, name, currentWebUiSettings());
        await refreshSettingsPresets();
        selectedPresetName.value = name;
        presetName.value = name;
        presetStatus.value = `Saved preset “${name}”.`;
        presetError.value = "";
    } catch (error) {
        presetError.value = error instanceof Error ? error.message : String(error);
    }
}

async function saveCurrentSettingsAsDefault(): Promise<void> {
    savingDefaultSettings.value = true;
    settingsError.value = "";
    try {
        await saveWebUiSettings(baseUrl.value, currentWebUiSettings());
        setMessage("Saved current settings as defaults. They will load on the next refresh.", "success");
    } catch (error) {
        settingsError.value = error instanceof Error ? error.message : String(error);
        setMessage(`Could not save default settings: ${settingsError.value}`, "error");
    } finally {
        savingDefaultSettings.value = false;
    }
}

function loadSelectedPreset(): void {
    const preset = settingsPresets.value.find((item) => item.name === selectedPresetName.value);
    if (!preset) {
        presetError.value = "Choose a saved preset first.";
        return;
    }
    applyWebUiSettings(preset.settings);
    presetName.value = preset.name;
    presetStatus.value = `Loaded preset “${preset.name}”.`;
    presetError.value = "";
}

async function refreshHistory(): Promise<void> {
    historyLoading.value = true;
    historyError.value = "";
    const selectedFilename = selectedHistoryImage.value?.filename;
    try {
        let revision = historyRevision;
        let response = await getImageHistory(baseUrl.value);
        while (revision !== historyRevision) {
            revision = historyRevision;
            response = await getImageHistory(baseUrl.value);
        }
        historyImages.value = response.images || [];
        if (selectedFilename) {
            selectedHistoryIndex.value = historyImages.value.findIndex((image) => image.filename === selectedFilename);
            if (selectedHistoryIndex.value < 0 && historyLightboxOpen.value) {
                closeLightbox();
            }
        } else if (historyImages.value.length && selectedHistoryIndex.value < 0) {
            selectedHistoryIndex.value = 0;
        }
        if (!historyImages.value.length) {
            selectedHistoryIndex.value = -1;
            if (historyLightboxOpen.value) {
                closeLightbox();
            }
        }
    } catch (error) {
        historyError.value = error instanceof Error ? error.message : String(error);
    } finally {
        historyLoading.value = false;
    }
}

function addCompletedJobImagesToHistory(job: Job): void {
    if (job.kind !== "img_gen") {
        return;
    }
    const filenames = [
        ...(job.completed_images || []),
        ...(job.result?.images || []).map((image) => image.filename || ""),
    ].filter(Boolean);
    if (!filenames.length) {
        return;
    }

    const existingFilenames = new Set(historyImages.value.map((image) => image.filename));
    const newImages = [...new Set(filenames)]
        .filter((filename) => !existingFilenames.has(filename))
        .map((filename) => ({ filename }));
    if (!newImages.length) {
        return;
    }

    const selectedFilename = selectedHistoryImage.value?.filename;
    historyRevision += 1;
    historyImages.value = [...historyImages.value, ...newImages]
        .sort((left, right) => right.filename.localeCompare(left.filename));
    if (selectedFilename) {
        selectedHistoryIndex.value = historyImages.value.findIndex((image) => image.filename === selectedFilename);
    } else if (selectedHistoryIndex.value < 0) {
        selectedHistoryIndex.value = 0;
    }
}

function openHistoryImage(filename: string): void {
    const index = historyImages.value.findIndex((image) => image.filename === filename);
    if (index < 0 || index >= historyImages.value.length) {
        return;
    }
    selectedHistoryIndex.value = index;
    historyLightboxOpen.value = true;
    historyDetailsVisible.value = false;
    lightboxOpen.value = true;
}

function moveHistorySelection(offset: number): void {
    const nextIndex = selectedHistoryIndex.value + offset;
    if (nextIndex >= 0 && nextIndex < historyImages.value.length) {
        selectedHistoryIndex.value = nextIndex;
    }
}

async function refreshSelectedHistorySettings(): Promise<void> {
    const requestId = ++historySettingsRequestId;
    const image = historyLightboxOpen.value ? selectedHistoryImage.value : null;
    historyImageSettings.value = null;
    historySettingsError.value = "";
    historyLoadFeedback.value = "";
    if (!image) {
        historySettingsLoading.value = false;
        return;
    }

    historySettingsLoading.value = true;
    try {
        const settings = await getHistorySettings(baseUrl.value, image.filename);
        if (requestId === historySettingsRequestId) {
            historyImageSettings.value = settings;
        }
    } catch (error) {
        if (requestId === historySettingsRequestId) {
            historySettingsError.value = error instanceof Error ? error.message : String(error);
        }
    } finally {
        if (requestId === historySettingsRequestId) {
            historySettingsLoading.value = false;
        }
    }
}

async function deleteHistoryImage(image: HistoryImage, fromLightbox = false): Promise<void> {
    if (pendingHistoryDeletes.has(image.filename)) {
        return;
    }
    pendingHistoryDeletes.add(image.filename);

    const index = historyImages.value.findIndex((entry) => entry.filename === image.filename);
    const selectedFilename = selectedHistoryImage.value?.filename;
    const selectedWasDeleted = selectedFilename === image.filename;
    const wasHistoryLightboxOpen = historyLightboxOpen.value;
    if (fromLightbox) {
        historyLightboxDeleteLoading.value = true;
    }

    if (index >= 0) {
        historyRevision += 1;
    }
    historyImages.value = historyImages.value.filter((entry) => entry.filename !== image.filename);
    if (!historyImages.value.length) {
        selectedHistoryIndex.value = -1;
        if (historyLightboxOpen.value) {
            closeLightbox();
        }
    } else if (selectedWasDeleted) {
        selectedHistoryIndex.value = Math.min(index, historyImages.value.length - 1);
        if (wasHistoryLightboxOpen) {
            historyLightboxOpen.value = true;
            lightboxOpen.value = true;
        }
    } else if (selectedFilename) {
        selectedHistoryIndex.value = historyImages.value.findIndex((entry) => entry.filename === selectedFilename);
    } else {
        selectedHistoryIndex.value = Math.min(Math.max(index, 0), historyImages.value.length - 1);
    }

    try {
        await deleteHistoryImageRequest(baseUrl.value, image.filename);
        setMessage(`Deleted ${image.filename}.`, "success");
    } catch (error) {
        await refreshHistory();
        setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
        pendingHistoryDeletes.delete(image.filename);
        if (fromLightbox) {
            historyLightboxDeleteLoading.value = false;
        }
    }
}

function deleteSelectedHistoryImage(): void {
    const image = selectedHistoryImage.value;
    if (image) {
        deleteHistoryImage(image, true);
    }
}

function reloadHistorySettings(): void {
    const image = selectedHistoryImage.value;
    const settings = historyImageSettings.value;
    if (!image || !settings) {
        return;
    }
    applyWebUiSettings(settings);
    historyLoadFeedback.value = `Loaded all settings from ${image.filename}.`;
}

function loadHistoryPrompts(includeSeed: boolean): void {
    const image = selectedHistoryImage.value;
    const savedForm = historyImageSettings.value?.form;
    if (!image || !savedForm) {
        return;
    }

    form.prompt = savedForm.prompt ?? "";
    form.negative_prompt = savedForm.negative_prompt ?? "";
    const savedSeed = savedForm.seed;
    const hasSavedSeed = typeof savedSeed === "number" && Number.isFinite(savedSeed);
    if (includeSeed && typeof savedSeed === "number" && Number.isFinite(savedSeed)) {
        form.seed = savedSeed;
    }
    if (includeSeed && !hasSavedSeed) {
        historyLoadFeedback.value = `Loaded prompts from ${image.filename}; no saved seed was available.`;
        return;
    }
    historyLoadFeedback.value = `Loaded ${includeSeed ? "prompts and seed" : "prompts"} from ${image.filename}.`;
}

async function refreshCapabilities(): Promise<void> {
    loadingCapabilities.value = true;
    capabilitiesError.value = "";
    try {
        const response = await getCapabilities(baseUrl.value);
        capabilities.value = response;
        serviceOnline.value = true;
        if (!formInitialized) {
            applyForm(formFromCapabilities(response), true);
            try {
                const savedSettings = await getWebUiSettings(baseUrl.value);
                applyWebUiSettings(savedSettings);
                settingsError.value = "";
            } catch (error) {
                settingsError.value = error instanceof Error ? error.message : String(error);
            }
            formInitialized = true;
        }
        if (selectedGenerationTab.value === "image" && !supportsImageMode.value && supportsVideoMode.value) {
            selectedGenerationTab.value = "video";
        } else if (selectedGenerationTab.value === "video" && !supportsVideoMode.value && supportsImageMode.value) {
            selectedGenerationTab.value = "image";
        }
        if (activeTab.value === "image" && !supportsImageMode.value && supportsVideoMode.value) {
            activeTab.value = "video";
        } else if (activeTab.value === "video" && !supportsVideoMode.value && supportsImageMode.value) {
            activeTab.value = "image";
        }
        ensureOutputFormatForMode();
        clearMessage();
    } catch (error) {
        capabilitiesError.value = error instanceof Error ? error.message : String(error);
        serviceOnline.value = false;
        setMessage(capabilitiesError.value, "error");
    } finally {
        loadingCapabilities.value = false;
    }
}

function toggleSection(section: string): void {
    sectionState[section] = !sectionState[section];
}

function selectGenerationMode(mode: GenerationMode): void {
    if (mode === "image" && !supportsImageMode.value) {
        setMessage("Current model only supports video generation.", "error");
        return;
    }
    if (mode === "video" && !supportsVideoMode.value) {
        setMessage("Current model only supports image generation.", "error");
        return;
    }
    selectedGenerationTab.value = mode;
    activeTab.value = mode;
    ensureOutputFormatForMode(mode);
}

function stopPolling(): void {
    if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = 0;
    }
}

function stopElapsedTimer(): void {
    if (elapsedTimer) {
        window.clearInterval(elapsedTimer);
        elapsedTimer = 0;
    }
}

function startElapsedTimer(): void {
    stopElapsedTimer();
    nowSeconds.value = Date.now() / 1000;
    elapsedTimer = window.setInterval(() => {
        nowSeconds.value = Date.now() / 1000;
    }, 100);
}

async function pollJob(id: string): Promise<void> {
    stopPolling();
    try {
        currentJob.value = await getJob(baseUrl.value, id);
        addCompletedJobImagesToHistory(currentJob.value);
        serviceOnline.value = true;
        if (currentStatus.value === "queued" || currentStatus.value === "generating") {
            pollTimer = window.setTimeout(() => pollJob(id), normalizePollIntervalMs(pollIntervalMs.value));
            clearMessage();
            return;
        }
        stopElapsedTimer();
        if (currentStatus.value === "completed") {
            if (currentJob.value?.kind === "vid_gen") {
                setMessage("Video generation completed.", "success");
            } else {
                const saveError = currentJob.value?.result?.save_error;
                if (saveError) {
                    setMessage(`Image generated, but saving to sdoutput failed: ${saveError}`, "error");
                } else {
                    setMessage("Image generation completed and saved to sdoutput.", "success");
                }
            }
            return;
        }
        if (currentStatus.value === "cancelled") {
            setMessage("Job cancelled.", "error");
            return;
        }
        if (currentStatus.value === "failed") {
            setMessage(currentJob.value?.error?.message || "Generation failed.", "error");
        }
    } catch (error) {
        stopElapsedTimer();
        serviceOnline.value = false;
        setMessage(error instanceof Error ? error.message : String(error), "error");
    }
}

async function generate(): Promise<void> {
    try {
        closeLightbox();
        const request = {
            ...buildRequestBodyForMode(generationMode.value, form),
            ui_settings: currentWebUiSettings(),
        };
        clearMessage();
        selectedOutputIndex.value = 0;
        startElapsedTimer();
        currentJob.value = generationMode.value === "video"
            ? await submitVideoJob(baseUrl.value, request)
            : await submitImageJob(baseUrl.value, request);
        await pollJob(currentJob.value.id);
    } catch (error) {
        stopElapsedTimer();
        setMessage(error instanceof Error ? error.message : String(error), "error");
    }
}

async function cancelCurrentJob(): Promise<void> {
    if (!currentJob.value?.id) {
        return;
    }
    try {
        currentJob.value = await cancelJob(baseUrl.value, currentJob.value.id);
        stopPolling();
        stopElapsedTimer();
        setMessage("Job cancelled.", "error");
    } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error), "error");
    }
}

function addLora(): void {
    form.lora.push({
        path: availableLoras.value[0]?.path || "",
        multiplier: 1,
        is_high_noise: false,
    });
}

function removeLora(index: number): void {
    form.lora.splice(index, 1);
}

async function assignImages(target: ImageTarget, files: FileList): Promise<void> {
    const images = await filesToImageEntries(files);
    if (!images.length) {
        return;
    }
    assignImageEntries(form, target, images);
}

function clearImage(target: ImageTarget): void {
    clearImageEntries(form, target);
}

function getFormImage(target: ImageTarget): ImageEntry | null {
    if (target === "ref_images" || target === "control_frames") return null;
    return form[target];
}

function openImageEntry(image: ImageEntry | null): void {
    openLightbox(image?.dataUrl, image?.name);
}

function removeCollectionImage(target: "ref_images" | "control_frames", index: number): void {
    removeImageEntry(form, target, index);
}

function selectOutput(index: number): void {
    selectedOutputIndex.value = index;
}

function formatUnixTime(seconds: number | undefined): string {
    if (!seconds) {
        return "No job";
    }
    return new Date(seconds * 1000).toLocaleString();
}

function formatElapsed(started: number | undefined, completed: number | undefined): string {
    if (!started) {
        return "Idle";
    }
    const end = completed || nowSeconds.value;
    const total = Math.max(0, end - started);
    if (total < 60) {
        return `${total.toFixed(1)}s`;
    }
    const minutes = Math.floor(total / 60);
    const seconds = total - minutes * 60;
    return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatSummaryNumber(value: number, digits = 3): string {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
        return "0";
    }
    return Number(numeric.toFixed(digits)).toString();
}

function downloadSelected(): void {
    if (!downloadableSrc.value) {
        return;
    }
    const link = document.createElement("a");
    link.href = downloadableSrc.value;
    link.download = historyLightboxOpen.value && selectedHistoryImage.value
        ? selectedHistoryImage.value.filename
        : `${currentJob.value?.id || "output"}.${currentJob.value?.result?.output_format || form.output_format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function openLightbox(src: string | null | undefined = previewImageSrc.value, alt = "Expanded image"): void {
    if (!src) {
        return;
    }
    historyLightboxOpen.value = false;
    lightboxImageSrc.value = src;
    lightboxImageAlt.value = alt;
    lightboxOpen.value = true;
}

function closeLightbox(): void {
    lightboxOpen.value = false;
    historyLightboxOpen.value = false;
    historyDetailsVisible.value = false;
    lightboxImageSrc.value = "";
    lightboxImageAlt.value = "";
}

function onLightboxKeydown(event: KeyboardEvent): void {
    if (!lightboxOpen.value) {
        return;
    }
    if (event.key === "Escape") {
        closeLightbox();
        return;
    }
    if (!historyLightboxOpen.value) {
        return;
    }
    if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveHistorySelection(-1);
    } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveHistorySelection(1);
    }
}

async function onPaste(event: ClipboardEvent): Promise<void> {
    if (!event.clipboardData?.files?.length) {
        return;
    }
    await assignImages("init_image", event.clipboardData.files);
    setMessage("Pasted image into init_image.", "success");
}

watch(generationMode, (mode) => {
    ensureOutputFormatForMode(mode);
});

watch(imageOutputFormats, () => {
    ensureOutputFormatForMode();
});

watch(videoOutputFormats, () => {
    ensureOutputFormatForMode();
});

watch(
    () => `${historyLightboxOpen.value ? "open" : "closed"}|${selectedHistoryImage.value?.filename || ""}|${baseUrl.value}`,
    () => {
        void refreshSelectedHistorySettings();
    },
);

onMounted(() => {
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onLightboxKeydown);
    refreshCapabilities();
    refreshSettingsPresets();
    refreshHistory();
});

onBeforeUnmount(() => {
    stopPolling();
    stopElapsedTimer();
    historySettingsRequestId += 1;
    window.removeEventListener("paste", onPaste);
    window.removeEventListener("keydown", onLightboxKeydown);
});
</script>

<template>
    <div class="shell">
        <header class="page-header panel">
            <div class="page-header__top">
                <div class="page-header__copy">
                    <div class="breadcrumb">
                        <span class="breadcrumb__org">stable-diffusion.cpp</span>
                        <span class="breadcrumb__slash">/</span>
                        <span>{{ modelName }}</span>
                    </div>
                    <h1 class="page-title">{{ modelName }}</h1>
                    <p class="page-description">
                        Native async image and video generation interface for the local `stable-diffusion.cpp` server.
                    </p>
                </div>
                <div class="page-header__meta">
                    <StatusChip :status="serviceOnline ? 'online' : 'offline'" :label="serviceOnline ? 'service online' : 'service unavailable'" />
                    <StatusChip :label="`queue ${queueLimit}`" />
                    <StatusChip :status="currentStatus" :label="currentStatus" />
                </div>
            </div>
            <div class="page-tabs">
                <div class="page-tabs__list">
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'image' }" type="button" @click="selectGenerationMode('image')" :disabled="!supportsImageMode">Image Generation</button>
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'video' }" type="button" @click="selectGenerationMode('video')" :disabled="!supportsVideoMode">Video Generation</button>
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'settings' }" type="button" @click="activeTab = 'settings'">Settings</button>
                </div>
                <div class="page-tabs__actions">
                    <button class="btn-secondary" type="button" @click="refreshCapabilities" :disabled="loadingCapabilities">{{ loadingCapabilities ? "Refreshing..." : "Refresh Server Info" }}</button>
                </div>
            </div>
            <div v-if="activeTab === 'settings'" class="settings">
                <section class="settings-presets">
                    <div class="panel-header">
                        <div>
                            <h2 class="panel-title">Settings Presets</h2>
                            <p class="hint">Save the current generation options under a name, then load them later.</p>
                        </div>
                    </div>
                    <div class="fields">
                        <div class="field">
                            <label>Saved Preset</label>
                            <select v-model="selectedPresetName">
                                <option value="">Choose a preset</option>
                                <option v-for="preset in settingsPresets" :key="preset.name" :value="preset.name">{{ preset.name }}</option>
                            </select>
                        </div>
                        <div class="field">
                            <label>Preset Name</label>
                            <input v-model="presetName" maxlength="80" placeholder="e.g. Portrait fast" />
                        </div>
                    </div>
                    <div class="actions settings-presets__actions">
                        <button class="btn-secondary" type="button" @click="loadSelectedPreset" :disabled="!selectedPresetName">Load Preset</button>
                        <button class="btn-secondary" type="button" @click="refreshSettingsPresets">Refresh List</button>
                        <button class="btn" type="button" @click="saveCurrentPreset">Save Current Settings</button>
                    </div>
                    <div v-if="presetError" class="status-message status-message--error">{{ presetError }}</div>
                    <div v-else-if="presetStatus" class="status-message status-message--success">{{ presetStatus }}</div>
                </section>
                <div class="settings__grid">
                    <div class="field">
                        <label>Base URL</label>
                        <input v-model="baseUrl" placeholder="Leave blank to use same origin" />
                    </div>
                    <div class="field">
                        <label>Queue Limit</label>
                        <input :value="queueLimit" readonly />
                    </div>
                    <div class="field">
                        <label>Output Formats ({{ generationMode === "video" ? "video" : "image" }})</label>
                        <input :value="outputFormats.join(', ')" readonly />
                    </div>
                    <div class="field">
                        <label>Output Format</label>
                        <select v-model="form.output_format">
                            <option v-for="format in outputFormats" :key="format" :value="format">{{ format }}</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>Output Compression</label>
                        <input v-model.number="form.output_compression" type="number" min="0" max="100" />
                    </div>
                    <div class="field">
                        <label>Job Poll Interval (ms)</label>
                        <input v-model.number="pollIntervalMs" type="number" min="1" step="1" />
                    </div>
                </div>
                <div v-if="capabilitiesError" class="status-message status-message--error">{{ capabilitiesError }}</div>
                <div class="hint">Click Set as Default on the main screen to save the current generation settings in sdcpp-webui-settings.json. Uploaded images are not saved.</div>
                <div v-if="settingsError" class="status-message status-message--error">Could not save or load settings: {{ settingsError }}</div>
            </div>
        </header>

        <div v-if="activeTab !== 'settings'" class="layout">
            <section class="panel control-panel">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title">Input</h2>
                    </div>
                </div>

                <div class="prompt-card">
                    <div class="field--full">
                        <label>Prompt</label>
                        <textarea v-model="form.prompt" :placeholder="generationMode === 'video' ? 'Describe the motion, scene, and framing you want to generate' : 'Describe the image you want to generate'" />
                    </div>
                    <div class="field--full stack-top">
                        <label>Negative Prompt</label>
                        <textarea v-model="form.negative_prompt" placeholder="What should be excluded?" />
                    </div>
                </div>

                <div class="fields stack-top">
                    <div class="field"><label>Width</label><input v-model.number="form.width" type="number" min="64" /></div>
                    <div class="field"><label>Height</label><input v-model.number="form.height" type="number" min="64" /></div>
                </div>

                <div v-if="generationMode === 'image'" class="fields stack-top">
                    <div class="field"><label>Batch Count</label><input v-model.number="form.batch_count" type="number" min="1" /></div>
                    <div class="field"><label>Seed</label><input v-model.number="form.seed" type="number" /></div>
                </div>
                <div v-else class="fields stack-top">
                    <div class="field"><label>Video Frames</label><input v-model.number="form.video_frames" type="number" min="1" /></div>
                    <div class="field"><label>FPS</label><input v-model.number="form.fps" type="number" min="1" /></div>
                </div>
                <div v-if="generationMode === 'video'" class="field stack-top">
                    <label>Seed</label>
                    <input v-model.number="form.seed" type="number" />
                </div>

                <CollapsibleSection class="stack-top" eyebrow="Sample" :summary="sampleSummary" :open="sectionState.sample" variant="module" @toggle="toggleSection('sample')">
                    <div class="fields">
                        <div class="field">
                            <label>Scheduler</label>
                            <select v-model="form.sample_params.scheduler">
                                <option value="default">default</option>
                                <option v-for="scheduler in schedulers" :key="scheduler" :value="scheduler">{{ scheduler }}</option>
                            </select>
                        </div>
                        <div class="field"><label>Flow Shift</label><input v-model="form.sample_params.flow_shift" type="number" step="0.01" placeholder="blank = default" /></div>
                        <div class="field">
                            <label>Method</label>
                            <select v-model="form.sample_params.sample_method">
                                <option value="default">default</option>
                                <option v-for="sampler in samplers" :key="sampler" :value="sampler">{{ sampler }}</option>
                            </select>
                        </div>
                        <div class="field"><label>Steps</label><input v-model.number="form.sample_params.sample_steps" type="number" /></div>
                    </div>
                    <div class="field field--full stack-top">
                        <label>Custom sigmas</label>
                        <input v-model="form.sample_params.custom_sigmas" type="text" placeholder="blank = use selected scheduler" />
                        <p class="hint">Comma-separated values override the scheduler. The number of steps is one less than the number of values.</p>
                    </div>
                    <div class="sample-panel__extras">
                        <button class="module-card__link" type="button" @click="toggleSection('sampleAdvanced')">
                            {{ sectionState.sampleAdvanced ? "Hide extras" : "Show extras" }}
                        </button>
                    </div>
                    <div v-if="sectionState.sampleAdvanced" class="fields">
                        <div class="field"><label>Eta</label><input v-model="form.sample_params.eta" type="number" step="0.01" placeholder="blank = default" /></div>
                        <div class="field"><label>Shifted Timestep</label><input v-model.number="form.sample_params.shifted_timestep" type="number" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="Guidance" :summary="guidanceSummary" :open="sectionState.guidance" variant="module" @toggle="toggleSection('guidance')">
                    <div class="fields">
                        <div class="field"><label>CFG Scale</label><input v-model.number="form.sample_params.guidance.txt_cfg" type="number" step="0.1" /></div>
                        <div class="field"><label>Distilled Guidance</label><input v-model.number="form.sample_params.guidance.distilled_guidance" type="number" step="0.1" /></div>
                    </div>
                    <div class="sample-panel__extras">
                        <button class="module-card__link" type="button" @click="toggleSection('guidanceAdvanced')">
                            {{ sectionState.guidanceAdvanced ? "Hide extras" : "Show extras" }}
                        </button>
                    </div>
                    <div v-if="sectionState.guidanceAdvanced" class="fields">
                        <div class="field"><label>Image CFG</label><input v-model="form.sample_params.guidance.img_cfg" type="number" step="0.1" placeholder="blank = follow text cfg" /></div>
                        <div class="field"><label>SLG Layers</label><input v-model="form.sample_params.guidance.slg_layers" placeholder="7,8,9" /></div>
                        <div class="field"><label>SLG Layer Start</label><input v-model.number="form.sample_params.guidance.layer_start" type="number" step="0.01" /></div>
                        <div class="field"><label>SLG Layer End</label><input v-model.number="form.sample_params.guidance.layer_end" type="number" step="0.01" /></div>
                        <div class="field"><label>SLG Scale</label><input v-model.number="form.sample_params.guidance.scale" type="number" step="0.01" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection v-if="generationMode === 'video'" class="stack-top" eyebrow="High Noise Pass" :summary="highNoiseSummary" :open="sectionState.highNoise" variant="module" @toggle="toggleSection('highNoise')">
                    <div class="field">
                        <label>MoE Boundary</label>
                        <input v-model.number="form.moe_boundary" type="number" step="0.001" />
                    </div>
                    <CollapsibleSection eyebrow="Sample" :summary="buildSampleSummary(form.high_noise_sample_params)" :open="sectionState.highNoiseSample" variant="plain" @toggle="toggleSection('highNoiseSample')">
                        <div class="fields">
                            <div class="field">
                                <label>Scheduler</label>
                                <select v-model="form.high_noise_sample_params.scheduler">
                                    <option value="default">default</option>
                                    <option v-for="scheduler in schedulers" :key="`high-noise-${scheduler}`" :value="scheduler">{{ scheduler }}</option>
                                </select>
                            </div>
                            <div class="field"><label>Flow Shift</label><input v-model="form.high_noise_sample_params.flow_shift" type="number" step="0.01" placeholder="blank = default" /></div>
                            <div class="field">
                                <label>Method</label>
                                <select v-model="form.high_noise_sample_params.sample_method">
                                    <option value="default">default</option>
                                    <option v-for="sampler in samplers" :key="`high-noise-${sampler}`" :value="sampler">{{ sampler }}</option>
                                </select>
                            </div>
                            <div class="field"><label>Steps</label><input v-model.number="form.high_noise_sample_params.sample_steps" type="number" /></div>
                            <div class="field"><label>Eta</label><input v-model="form.high_noise_sample_params.eta" type="number" step="0.01" placeholder="blank = auto" /></div>
                            <div class="field"><label>Shifted Timestep</label><input v-model.number="form.high_noise_sample_params.shifted_timestep" type="number" /></div>
                        </div>
                    </CollapsibleSection>
                    <CollapsibleSection class="stack-top" eyebrow="Guidance" :summary="buildGuidanceSummary(form.high_noise_sample_params)" :open="sectionState.highNoiseGuidance" variant="plain" @toggle="toggleSection('highNoiseGuidance')">
                        <div class="fields">
                            <div class="field"><label>CFG Scale</label><input v-model.number="form.high_noise_sample_params.guidance.txt_cfg" type="number" step="0.1" /></div>
                            <div class="field"><label>Distilled Guidance</label><input v-model.number="form.high_noise_sample_params.guidance.distilled_guidance" type="number" step="0.1" /></div>
                            <div class="field"><label>Image CFG</label><input v-model="form.high_noise_sample_params.guidance.img_cfg" type="number" step="0.1" placeholder="blank = follow text cfg" /></div>
                            <div class="field"><label>SLG Layers</label><input v-model="form.high_noise_sample_params.guidance.slg_layers" placeholder="7,8,9" /></div>
                            <div class="field"><label>SLG Layer Start</label><input v-model.number="form.high_noise_sample_params.guidance.layer_start" type="number" step="0.01" /></div>
                            <div class="field"><label>SLG Layer End</label><input v-model.number="form.high_noise_sample_params.guidance.layer_end" type="number" step="0.01" /></div>
                            <div class="field"><label>SLG Scale</label><input v-model.number="form.high_noise_sample_params.guidance.scale" type="number" step="0.01" /></div>
                        </div>
                    </CollapsibleSection>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="Conditioning" :summary="conditioningSummary" :open="sectionState.conditioning" @toggle="toggleSection('conditioning')">
                    <div class="fields">
                        <div class="field"><label>CLIP Skip</label><input v-model.number="form.clip_skip" type="number" /></div>
                        <div class="field"><label>Strength</label><input v-model.number="form.strength" type="number" step="0.01" /></div>
                        <div v-if="generationMode === 'image'" class="field"><label>Control Strength</label><input v-model.number="form.control_strength" type="number" step="0.01" /></div>
                        <div v-if="generationMode === 'video'" class="field"><label>VACE Strength</label><input v-model.number="form.vace_strength" type="number" step="0.01" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="LoRA" :summary="loraSummary" :open="sectionState.lora" @toggle="toggleSection('lora')">
                    <div v-if="!availableLoras.length" class="hint">No LoRA entries were returned by capabilities.</div>
                    <div v-else-if="!form.lora.length" class="hint">No LoRA overrides configured.</div>
                    <div v-else class="list-editor">
                        <div class="list-row list-row--header">
                            <div>LoRA</div>
                            <div>Multiplier</div>
                            <div>High Noise</div>
                            <div></div>
                        </div>
                        <div v-for="(item, index) in form.lora" :key="index" class="list-row">
                            <select v-model="item.path">
                                <option v-for="lora in availableLoras" :key="lora.path" :value="lora.path">
                                    {{ lora.name }} ({{ lora.path }})
                                </option>
                            </select>
                            <input v-model.number="item.multiplier" type="number" step="0.1" />
                            <label class="checkbox list-row__checkbox">
                                <input v-model="item.is_high_noise" type="checkbox" />
                                <span>{{ item.is_high_noise ? "On" : "Off" }}</span>
                            </label>
                            <button class="btn-ghost" type="button" @click="removeLora(index)">Remove</button>
                        </div>
                    </div>
                    <div><button class="btn-ghost" type="button" @click="addLora" :disabled="!availableLoras.length">Add LoRA</button></div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="Image Inputs" :summary="imageInputsSummary" :open="sectionState.auxiliaryImages" @toggle="toggleSection('auxiliaryImages')">
                    <div class="upload-grid">
                        <ImageDropzone
                            v-for="input in gridImageInputs"
                            :key="input.target"
                            :label="input.label"
                            :description="input.description"
                            :preview="getFormImage(input.target)"
                            @select="assignImages(input.target, $event)"
                            @clear="clearImage(input.target)"
                            @preview="openImageEntry($event)"
                        />
                    </div>
                    <div v-for="input in fullImageInputs" :key="input.target">
                        <ImageDropzone
                            :label="input.label"
                            :description="input.description"
                            :preview="getFormImage(input.target)"
                            @select="assignImages(input.target, $event)"
                            @clear="clearImage(input.target)"
                            @preview="openImageEntry($event)"
                        />
                    </div>

                    <div v-if="generationMode === 'image'" class="group">
                        <label>Reference Images</label>
                        <ImageDropzone
                            label="Reference Images"
                            description="Multiple reference images supported."
                            :items="form.ref_images"
                            multiple
                            @select="assignImages('ref_images', $event)"
                            @clear="clearImage('ref_images')"
                        />
                        <div v-if="!form.ref_images.length" class="hint">No files selected.</div>
                        <div v-else class="file-list">
                            <div v-for="(item, index) in form.ref_images" :key="item.name + index" class="file-chip file-chip--preview">
                                <button class="file-chip__thumb-button" type="button" @click="openLightbox(item.dataUrl, item.name)">
                                    <img class="file-chip__thumb" :src="item.dataUrl" :alt="item.name" />
                                </button>
                                <span class="file-chip__name">{{ item.name }}</span>
                                <button class="icon-button" type="button" @click="removeCollectionImage('ref_images', index)">Remove</button>
                            </div>
                        </div>
                    </div>

                    <div v-else>
                        <div class="group">
                            <label>Reference Images (MiniMax-H3 Ref2VA only)</label>
                            <ImageDropzone
                                label="Reference Images"
                                description="Only MiniMax-H3 Ref2VA uses these images; other video models ignore them. Cannot be combined with an initial or end frame."
                                :items="form.ref_images"
                                multiple
                                @select="assignImages('ref_images', $event)"
                                @clear="clearImage('ref_images')"
                            />
                            <div v-if="!form.ref_images.length" class="hint">No files selected.</div>
                            <div v-else class="file-list">
                                <div v-for="(item, index) in form.ref_images" :key="item.name + index" class="file-chip file-chip--preview">
                                    <button class="file-chip__thumb-button" type="button" @click="openLightbox(item.dataUrl, item.name)">
                                        <img class="file-chip__thumb" :src="item.dataUrl" :alt="item.name" />
                                    </button>
                                    <span class="file-chip__name">{{ item.name }}</span>
                                    <button class="icon-button" type="button" @click="removeCollectionImage('ref_images', index)">Remove</button>
                                </div>
                            </div>
                        </div>
                        <div class="group stack-top">
                            <label>Control Frames</label>
                            <ImageDropzone
                                label="Control Frames"
                                description="Upload ordered conditioning frames. The server preserves the array order."
                                :items="form.control_frames"
                                multiple
                                @select="assignImages('control_frames', $event)"
                                @clear="clearImage('control_frames')"
                            />
                            <div v-if="!form.control_frames.length" class="hint">No files selected.</div>
                            <div v-else class="file-list">
                                <div v-for="(item, index) in form.control_frames" :key="item.name + index" class="file-chip file-chip--preview">
                                    <button class="file-chip__thumb-button" type="button" @click="openLightbox(item.dataUrl, item.name)">
                                        <img class="file-chip__thumb" :src="item.dataUrl" :alt="item.name" />
                                    </button>
                                    <span class="file-chip__name">{{ item.name }}</span>
                                    <button class="icon-button" type="button" @click="removeCollectionImage('control_frames', index)">Remove</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="VAE Tiling" :summary="vaeTilingSummary" :open="sectionState.vaeTiling" @toggle="toggleSection('vaeTiling')">
                    <label class="checkbox"><input v-model="form.vae_tiling_params.enabled" type="checkbox" /><span>Enabled</span></label>
                    <div class="fields">
                        <div class="field"><label>Tile Width (px)</label><input v-model.number="form.vae_tiling_params.tile_size_w" type="number" /></div>
                        <div class="field"><label>Tile Height (px)</label><input v-model.number="form.vae_tiling_params.tile_size_h" type="number" /></div>
                    </div>
                    <div class="field"><label>Target Overlap</label><input v-model.number="form.vae_tiling_params.target_overlap" type="number" step="0.01" /></div>
                    <div class="fields">
                        <div class="field"><label>Relative Width</label><input v-model.number="form.vae_tiling_params.rel_size_w" type="number" step="0.01" /></div>
                        <div class="field"><label>Relative Height</label><input v-model.number="form.vae_tiling_params.rel_size_h" type="number" step="0.01" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection v-if="supportsPreview" class="stack-top" eyebrow="Preview" :summary="form.preview_mode === 'none' ? 'Disabled' : form.preview_mode" :open="sectionState.preview" @toggle="toggleSection('preview')">
                    <div class="fields">
                        <div class="field">
                            <label>Preview Mode</label>
                            <select v-model="form.preview_mode">
                                <option v-for="mode in previewModes" :key="mode" :value="mode">{{ mode }}</option>
                            </select>
                        </div>
                        <div class="field">
                            <label>Interval (steps)</label>
                            <input v-model.number="form.preview_interval" type="number" min="1" step="1" />
                        </div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="Cache" :summary="cacheSummary" :open="sectionState.cache" @toggle="toggleSection('cache')">
                    <div class="field">
                        <label>Mode</label>
                        <select v-model="form.cache.mode">
                            <option v-for="mode in CACHE_MODES" :key="mode" :value="mode">{{ mode }}</option>
                        </select>
                    </div>
                    <div class="field field--full"><label>Cache Option</label><input v-model="form.cache.option" placeholder="threshold=0.25,start=0.15,end=0.95" /></div>
                    <div class="field"><label>SCM Mask</label><input v-model="form.cache.scm_mask" /></div>
                    <label class="checkbox"><input v-model="form.cache.scm_policy_dynamic" type="checkbox" /><span>Dynamic SCM Policy</span></label>
                </CollapsibleSection>
            </section>

            <section class="panel output-panel">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title">Output</h2>
                    </div>
                </div>

                <div v-if="livePreviewSrc" class="hero-frame hero-frame--media hero-frame--preview">
                    <img class="hero-frame__image" :src="livePreviewSrc" alt="Live preview" />
                    <div class="hero-frame__preview-overlay">
                        <span class="hero-frame__preview-label">Preview</span>
                        <span class="hero-frame__preview-step">Pass {{ livePreviewPass }} · {{ livePreviewStep }} / {{ livePreviewTotalSteps }} steps</span>
                    </div>
                </div>
                <div v-else-if="videoPreviewSrc" class="hero-frame hero-frame--media">
                    <video class="hero-frame__video" :src="videoPreviewSrc" controls autoplay loop muted playsinline />
                </div>
                <button v-else class="hero-frame hero-frame--button" type="button" :disabled="!previewImageSrc" @click="openLightbox(previewImageSrc, 'Generated output')">
                    <img v-if="previewImageSrc" :src="previewImageSrc" alt="Generated output" />
                    <div v-else class="hero-placeholder">
                        <h2>{{ generationMode === "video" ? "Generate Video" : "Generate Images" }}</h2>
                        <p>
                            {{ generationMode === "video"
                                ? "Generated video or animated WebP output will appear here once the current job finishes."
                                : "Generated images will appear here once the current job finishes." }}
                        </p>
                    </div>
                </button>

                <div v-if="currentJobKind === 'vid_gen' && currentJob?.result?.output_format === 'avi'" class="hint stack-top">
                    Browser playback for AVI depends on codec support. Download the file if the preview cannot play.
                </div>

                <div class="metrics output-metrics">
                    <div class="metric">
                        <div class="metric__label">Status</div>
                        <div class="metric__value">{{ currentStatus }}</div>
                    </div>
                    <div class="metric">
                        <div class="metric__label">Queue</div>
                        <div class="metric__value">{{ currentJob?.queue_position ?? 0 }}</div>
                    </div>
                    <div class="metric">
                        <div class="metric__label">Created</div>
                        <div class="metric__value mono">{{ formatUnixTime(currentJob?.created) }}</div>
                    </div>
                    <div class="metric">
                        <div class="metric__label">Elapsed</div>
                        <div class="metric__value">{{ formatElapsed(currentJob?.started, currentJob?.completed) }}</div>
                    </div>
                    <div v-if="currentJobKind === 'vid_gen'" class="metric">
                        <div class="metric__label">FPS</div>
                        <div class="metric__value">{{ videoFps || "-" }}</div>
                    </div>
                    <div v-if="currentJobKind === 'vid_gen'" class="metric">
                        <div class="metric__label">Frames</div>
                        <div class="metric__value">{{ videoFrameCount || "-" }}</div>
                    </div>
                </div>

                <div v-if="statusMessage" class="status-message" :class="statusTone === 'error' ? 'status-message--error' : 'status-message--success'">{{ statusMessage }}</div>
                <div v-else-if="currentJob?.error?.message" class="status-message status-message--error">{{ currentJob.error.message }}</div>

                <div class="output-controls">
                    <button class="btn output-controls__primary" type="button" :disabled="isJobRunning" @click="generate">
                        {{ generationMode === "video" ? "Generate Video" : "Generate Image" }}
                    </button>
                    <div class="actions output-controls__secondary">
                        <button class="btn-secondary" type="button" :disabled="!downloadableSrc" @click="downloadSelected">Download</button>
                        <button class="btn-danger" type="button" :disabled="!canCancelCurrentJob" @click="cancelCurrentJob">Cancel</button>
                    </div>
                    <button class="btn-secondary output-controls__default" type="button" :disabled="savingDefaultSettings || !serviceOnline" @click="saveCurrentSettingsAsDefault">
                        {{ savingDefaultSettings ? "Saving Defaults…" : "Set as Default" }}
                    </button>
                </div>

                <div v-if="currentImages.length > 1" class="thumb-row">
                    <button v-for="(image, index) in currentImages" :key="image.index" class="thumb" :class="{ 'thumb--active': index === selectedOutputIndex }" type="button" @click="selectOutput(index)">
                        <img :src="`data:image/${currentJob?.result?.output_format || 'png'};base64,${image.b64_json}`" :alt="`Output ${index + 1}`" />
                    </button>
                </div>

                <section class="history-gallery">
                    <div class="history-gallery__header">
                        <div>
                            <h3>Image History</h3>
                            <span>{{ historyImages.length }} saved {{ historyImages.length === 1 ? "image" : "images" }}</span>
                        </div>
                        <button class="btn-secondary" type="button" @click="refreshHistory" :disabled="historyLoading">
                            {{ historyLoading ? "Refreshing..." : "Refresh" }}
                        </button>
                    </div>
                    <div v-if="historyError" class="status-message status-message--error">{{ historyError }}</div>
                    <div v-else-if="!historyImages.length" class="hint">Generated images will appear here.</div>
                    <div v-else class="history-grid">
                        <div
                            v-for="(image, index) in historyImages"
                            :key="image.filename"
                            v-memo="[historyLightboxOpen && selectedHistoryImage?.filename === image.filename]"
                            class="history-card"
                            :class="{ 'history-card--active': historyLightboxOpen && selectedHistoryImage?.filename === image.filename }"
                        >
                            <button class="history-card__open" type="button" @click="openHistoryImage(image.filename)">
                                <img :src="imageHistoryUrl(baseUrl, image.filename, true)" :alt="image.filename" loading="lazy" />
                                <span>{{ image.filename.replace(/\.png$/i, "") }}</span>
                            </button>
                            <button
                                class="history-card__delete"
                                type="button"
                                :aria-label="`Delete ${image.filename}`"
                                @click="deleteHistoryImage(image)"
                            >Delete</button>
                        </div>
                    </div>
                </section>
            </section>
        </div>
        <div
            v-if="lightboxOpen && (historyLightboxOpen ? historyImageSrc : lightboxImageSrc)"
            class="lightbox"
            @click.self="closeLightbox"
        >
            <button class="lightbox__close" type="button" @click="closeLightbox">Close</button>
            <img
                class="lightbox__image"
                :class="{
                    'lightbox__image--history': historyLightboxOpen,
                    'lightbox__image--history-details-visible': historyLightboxOpen && historyDetailsVisible,
                }"
                :src="(historyLightboxOpen ? historyImageSrc : lightboxImageSrc) || ''"
                :alt="historyLightboxOpen ? selectedHistoryImage?.filename : lightboxImageAlt"
            />
            <div v-if="historyLightboxOpen && selectedHistoryImage" class="lightbox__history-controls">
                <div class="lightbox__history-navigation">
                    <button
                        class="lightbox__history-button"
                        type="button"
                        aria-label="Previous image"
                        :disabled="selectedHistoryIndex <= 0"
                        @click="moveHistorySelection(-1)"
                    >‹</button>
                    <span class="lightbox__history-label">{{ selectedHistoryImage.filename }} · {{ selectedHistoryIndex + 1 }} / {{ historyImages.length }}</span>
                    <button
                        class="lightbox__history-button"
                        type="button"
                        aria-label="Next image"
                        :disabled="selectedHistoryIndex >= historyImages.length - 1"
                        @click="moveHistorySelection(1)"
                    >›</button>
                    <button
                        class="lightbox__history-button lightbox__history-toggle"
                        type="button"
                        :aria-expanded="historyDetailsVisible"
                        @click="historyDetailsVisible = !historyDetailsVisible"
                    >{{ historyDetailsVisible ? "Hide Info" : "Show Info" }}</button>
                </div>
                <section v-if="historyDetailsVisible" class="lightbox__history-details" aria-label="Image generation settings">
                    <div v-if="historySettingsLoading" class="lightbox__history-message">Loading image settings…</div>
                    <div v-else-if="historySettingsError" class="lightbox__history-message lightbox__history-message--error">{{ historySettingsError }}</div>
                    <template v-else-if="historyImageSettings">
                        <div class="lightbox__history-prompts">
                            <label>
                                <span>Prompt</span>
                                <textarea readonly rows="2" :value="historyImageSettings.form.prompt || ''"></textarea>
                            </label>
                            <label>
                                <span>Negative Prompt</span>
                                <textarea readonly rows="2" :value="historyImageSettings.form.negative_prompt || ''"></textarea>
                            </label>
                        </div>
                        <dl class="lightbox__history-metadata">
                            <div><dt>CFG Scale</dt><dd>{{ historyImageDetails.cfgScale }}</dd></div>
                            <div><dt>Steps</dt><dd>{{ historyImageDetails.steps }}</dd></div>
                            <div><dt>Scheduler</dt><dd>{{ historyImageDetails.scheduler }}</dd></div>
                            <div><dt>Sampling Method</dt><dd>{{ historyImageDetails.method }}</dd></div>
                            <div><dt>Seed</dt><dd>{{ historyImageDetails.seed }}</dd></div>
                        </dl>
                    </template>
                </section>
                <div class="lightbox__history-actions">
                    <button class="lightbox__history-button" type="button" :disabled="historySettingsLoading || !historyImageSettings" @click="reloadHistorySettings">Load All Settings</button>
                    <button class="lightbox__history-button" type="button" :disabled="historySettingsLoading || !historyImageSettings" @click="loadHistoryPrompts(false)">Load Prompts</button>
                    <button class="lightbox__history-button" type="button" :disabled="historySettingsLoading || !historyImageSettings" @click="loadHistoryPrompts(true)">Load Prompts + Seed</button>
                    <button
                        class="lightbox__history-button lightbox__history-button--delete"
                        type="button"
                        :disabled="historyLightboxDeleteLoading"
                        @click="deleteSelectedHistoryImage"
                    >Delete</button>
                </div>
                <div v-if="historyLoadFeedback" class="lightbox__history-feedback" role="status">{{ historyLoadFeedback }}</div>
            </div>
        </div>
    </div>
</template>

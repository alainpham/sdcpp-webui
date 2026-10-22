import { onBeforeUnmount, watch } from "vue";

import { createStoredRef } from "./settings";

type Theme = "system" | "light" | "dark";

export function useTheme() {
    const theme = createStoredRef<Theme>("sdcpp-webui-theme", "system", (value: unknown) =>
        value === "light" || value === "dark" ? value : "system");
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
        document.documentElement.dataset.theme = theme.value === "system"
            ? (systemTheme.matches ? "dark" : "light")
            : theme.value;
    };

    watch(theme, applyTheme, { immediate: true });
    systemTheme.addEventListener("change", applyTheme);
    onBeforeUnmount(() => systemTheme.removeEventListener("change", applyTheme));

    return theme;
}

export const PYTHON_PACKAGES = {
  ipython: {
    label: "IPython",
    module: "IPython",
    distribution: "ipython",
  },
  ipykernel: {
    label: "IPykernel",
    module: "ipykernel",
    distribution: "ipykernel",
  },
  jupyterClient: {
    label: "Jupyter Client",
    module: "jupyter_client",
    distribution: "jupyter-client",
  },
  manim: {
    label: "Manim Community",
    module: "manim",
    distribution: "manim",
  },
  manimSlides: {
    label: "Manim Slides",
    module: "manim_slides",
    distribution: "manim-slides",
  },
  pythonPptx: {
    label: "python-pptx",
    module: "pptx",
    distribution: "python-pptx",
  },
} as const;

export type PythonPackageId = keyof typeof PYTHON_PACKAGES;
export type EnvironmentFeature = "runtime" | "presentation" | "powerPoint";

export interface PythonPackageReport {
  installed: boolean;
  version?: string;
}

export interface PythonEnvironmentReport {
  executable: string;
  pythonVersion: string;
  packages: Record<PythonPackageId, PythonPackageReport>;
  pipAvailable: boolean;
  typstPath?: string;
}

const FEATURE_PACKAGES: Record<EnvironmentFeature, readonly PythonPackageId[]> = {
  runtime: ["ipython", "ipykernel", "jupyterClient", "manim", "manimSlides"],
  presentation: ["ipython", "ipykernel", "jupyterClient", "manim", "manimSlides"],
  powerPoint: ["ipython", "ipykernel", "jupyterClient", "manim", "manimSlides", "pythonPptx"],
};

export function missingPackages(
  report: PythonEnvironmentReport,
  feature: EnvironmentFeature,
): PythonPackageId[] {
  return FEATURE_PACKAGES[feature].filter((id) => !report.packages[id].installed);
}

/**
 * Return the smallest practical pip request for the missing imports. Extras
 * are intentionally installed only when needed; selecting a feature must not
 * upgrade an otherwise healthy Manim environment.
 */
export function pipRequirementsForMissing(
  missing: readonly PythonPackageId[],
): string[] {
  const ids = new Set(missing);
  const requirements: string[] = [];
  if (ids.has("manimSlides")) {
    requirements.push("manim-slides[manim]>=5.6");
    ids.delete("manimSlides");
    ids.delete("manim");
  }
  if (ids.delete("manim")) requirements.push("manim>=0.19");
  if (ids.delete("ipython")) requirements.push("ipython>=8.12");
  if (ids.delete("ipykernel")) requirements.push("ipykernel>=6.29");
  if (ids.delete("jupyterClient")) requirements.push("jupyter-client>=8");
  if (ids.delete("pythonPptx")) requirements.push("python-pptx>=0.6.21");
  return requirements;
}

export function packageLabels(ids: readonly PythonPackageId[]): string {
  return ids.map((id) => PYTHON_PACKAGES[id].label).join("、");
}

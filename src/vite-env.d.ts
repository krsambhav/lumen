/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by scripts/shot.sh to compile the development gallery into the bundle. */
  readonly VITE_LUMEN_DEVTOOLS?: string;
}

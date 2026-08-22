import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 번들 설정 — ZeroDot의 `/g/<slug>/` 하위 경로에서 서빙된다.
 * 같은 오리진이어야 게임의 localStorage(영구 진행)가 Safari에서 살아남는다
 * (플랫폼 architecture.md).
 */
const GAME_VERSION = process.env.GAME_VERSION ?? "dev";

export default defineConfig({
  base: "/g/scrapworks/",
  plugins: [react()],
  define: {
    __GAME_VERSION__: JSON.stringify(GAME_VERSION),
  },
  build: {
    // 번들 예산 2MB — 청크가 조용히 커지는 것을 막으려면 경고선이 예산보다 낮아야 한다
    chunkSizeWarningLimit: 500,
  },
});

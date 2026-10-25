export function registerSlidesKernel(kernel: Record<string, unknown>): {
  buildAllRenderSlides(opened: import('../vendor/genoffice/packages/pptx-engine/src').OpenedPptx, fitWidth: number): import('../vendor/genoffice/packages/pptx-render/src').RenderSlide[]
  deckDefaultFont(opened: import('../vendor/genoffice/packages/pptx-engine/src').OpenedPptx): string
}
export const supportedSlidesChannels: string[]

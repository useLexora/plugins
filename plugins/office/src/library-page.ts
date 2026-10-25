import type { ViewContext } from './lexora'
import { renderOffice } from './view'
export function render(context: ViewContext, container: HTMLElement) { return renderOffice(context, container, false) }

import { activateManager } from './manager.js'

export async function activate(context) {
  const [manifest, catalog, specifications] = await Promise.all([
    fetch('/__package/extension.json').then(response => response.json()),
    fetch('/__package/catalog.json').then(response => response.json()),
    fetch('/__package/resources.json').then(response => response.json()),
  ])
  await activateManager(context, { manifest, catalog, specifications })
}

import { createRequire } from 'node:module'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { project, repository } from './__tests__/paths.mjs'

const { defineConfig } = createRequire(path.join(repository, 'package.json'))('@playwright/test')
const artifacts = process.env.LEXORA_TEST_ARTIFACT_DIR ??= path.join(project, 'artifacts', `desktop-${randomUUID()}`)

export default defineConfig({
  testDir: path.join(project, '__tests__'),
  testMatch: ['office.e2e.mjs', 'sheets.e2e.mjs', 'slides.e2e.mjs', 'pdf.e2e.mjs', 'docx-mail-merge.e2e.mjs', 'source-opening.e2e.mjs'],
  outputDir: path.join(artifacts, 'results'),
  reporter: [['list'], ['html', { outputFolder: path.join(artifacts, 'report'), open: 'never' }], ['json', { outputFile: path.join(artifacts, 'report.json') }]],
  workers: 1,
  retries: 0,
  timeout: 240000,
  expect: { timeout: 20000 },
  projects: [{ name: 'electron-office' }],
})

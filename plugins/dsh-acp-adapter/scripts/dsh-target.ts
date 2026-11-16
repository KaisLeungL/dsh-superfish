import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  devDependencies?: Record<string, string>
}
export const DSH_SOURCE_VERSION = pkg.devDependencies?.['@deepseek-ai/dsh']
if (typeof DSH_SOURCE_VERSION !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(DSH_SOURCE_VERSION)) {
  throw new Error('package.json devDependencies["@deepseek-ai/dsh"] must name one exact released host version')
}
export const DSH_SOURCE_TAG = `dsh-v${DSH_SOURCE_VERSION}`
export const DSH_COMPAT_RANGE = `>=${DSH_SOURCE_VERSION} <0.3.0`

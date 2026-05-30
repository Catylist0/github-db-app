// GitHub Contents API read/write helpers.
// Stub — to be implemented once auth is wired up.

import type { Project } from '../types'

const API_BASE = 'https://api.github.com'

export interface StorageConfig {
  owner: string
  repo: string
  token: string
}

export async function readProject(
  _config: StorageConfig,
  _path: string,
): Promise<Project> {
  // TODO: GET /repos/{owner}/{repo}/contents/{path}
  //       decode base64 content and parse JSON
  throw new Error('Storage not yet implemented')
}

export async function writeProject(
  _config: StorageConfig,
  _path: string,
  _project: Project,
  _sha?: string,
): Promise<void> {
  // TODO: PUT /repos/{owner}/{repo}/contents/{path}
  //       base64-encode JSON payload, include sha for updates
  throw new Error('Storage not yet implemented')
}

export async function listProjects(
  _config: StorageConfig,
  _dir: string,
): Promise<string[]> {
  // TODO: GET /repos/{owner}/{repo}/contents/{dir}
  //       return array of file paths
  throw new Error('Storage not yet implemented')
}

// Kept to avoid unused-import lint errors during stub phase.
export { API_BASE }

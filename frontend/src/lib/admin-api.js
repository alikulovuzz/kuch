import { api } from './api.js'

// Every admin surface, including a sheet outside the route tree, revokes its visible
// data together when the server no longer authorizes the session.
export async function adminApi(path, options) {
  try { return await api(path, options) }
  catch (error) {
    if (error.status === 401 || (error.status === 403 && path.startsWith('/api/admin/'))) window.dispatchEvent(new Event('kuch-admin-access-lost'))
    throw error
  }
}

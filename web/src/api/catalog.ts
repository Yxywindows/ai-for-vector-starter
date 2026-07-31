import { apiFetch } from './client'
import type { GeometryTableInfo } from './types'

export const listPostgisTables = () => apiFetch<GeometryTableInfo[]>('/connections/postgis/tables')

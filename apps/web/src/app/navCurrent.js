export function filesNavCurrent(pathname) {
  return pathname === '/files'
    || pathname.startsWith('/folders/')
    || pathname.startsWith('/view/');
}

export function workspacesNavCurrent(pathname) {
  return pathname === '/workspaces'
    || pathname.startsWith('/workspaces/')
    || pathname.startsWith('/snapshots/');
}

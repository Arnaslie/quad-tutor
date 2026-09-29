const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** @param {string} hostname */
export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname);
}

/**
 * The admin URL with its identity repeated as query parameters, which Bun reads first. Identity
 * parameters the URL already carries stay; the user and database of the URL fill in only the
 * missing ones.
 */
export function queryAdminUrl(url: string) {
    const admin = new URL(url)
    if (!admin.searchParams.has('user')) {
        admin.searchParams.set('user', decodeURIComponent(admin.username) || 'postgres')
    }
    if (!admin.searchParams.has('dbname')) {
        admin.searchParams.set('dbname', admin.pathname.slice(1) || 'postgres')
    }
    return admin.href
}

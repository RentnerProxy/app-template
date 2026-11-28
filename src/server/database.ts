import { SQL } from 'bun'

/**
 * Connect to the app database as its runtime role. The platform provisions the database for apps
 * that declare `data`, runs the declared migrations as a separate schema owner and passes a
 * private URL file. The runtime role may only read and change rows in the `app` schema, so schema
 * changes belong in a migration. Keep the URL out of logs: it contains the password.
 */
export async function openAppDatabase(path = process.env.RENTNERPROXY_APP_DATABASE_URL_FILE) {
    if (!path) throw new Error('The platform provides no app database')
    const url = (await Bun.file(path).text()).trim()
    if (!/^postgres(?:ql)?:\/\//u.test(url)) throw new Error('Invalid app database URL')
    return new SQL({ adapter: 'postgres', url, connectionTimeout: 5 })
}

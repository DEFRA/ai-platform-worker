import { exitOnUnhandledRejection } from '#/common/helpers/exit-on-unhandled-rejection.js'
import { startServer } from '#/common/helpers/start-server.js'

exitOnUnhandledRejection()

await startServer()

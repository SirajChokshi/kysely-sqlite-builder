import type {
  Compilable,
  Dialect,
  KyselyPlugin,
  QueryResult,
  RawBuilder,
  RootOperationNode,
  SelectQueryBuilder,
  Simplify,
  Transaction,
} from 'kysely'
import { CompiledQuery, Kysely, SelectQueryNode } from 'kysely'
import type { Promisable } from '@subframe7536/type-utils'
import { SerializePlugin, type SerializePluginOptions, defaultSerializer } from 'kysely-plugin-serialize'
import {
  type LoggerOptions,
  type SqliteExecutor,
  type SqliteExecutorFn,
  basicExecutorFn,
  createKyselyLogger,
  checkIntegrity as runCheckIntegrity,
  savePoint,
} from './utils'

import type {
  AvailableBuilder,
  DBLogger,
  QueryBuilderOutput,
  StatusResult,
  TableUpdater,
} from './types'

export class IntegrityError extends Error {
  constructor() {
    super('db file maybe corrupted')
  }
}

export interface SqliteBuilderOptions<T extends Record<string, any>, Extra extends Record<string, any>> {
  dialect: Dialect
  /**
   * call on `dialect.log`, wrapped with `createKyselyLogger`
   *
   * if value is `true`, logger is `console.log` and `merge: true`
   */
  onQuery?: boolean | LoggerOptions
  /**
   * additional plugins
   *
   * **do NOT use camelCase plugin with useSchema**, this will lead to sync table fail
   */
  plugins?: KyselyPlugin[]
  /**
   * db logger
   */
  logger?: DBLogger
  /**
   * options for serializer plugin
   */
  serializerPluginOptions?: SerializePluginOptions
  /**
   * custom executor
   * @example
   * import { createSoftDeleteExecutorFn } from 'kysely-sqlite-builder/utils'
   *
   * const softDeleteExecutorFn = createSoftDeleteExecutorFn({
   *   deleteColumn: 'isDeleted',
   *   deleteValue: 1,
   *   notDeleteValue: 0,
   * })
   * const builder = new SqliteBuilder({
   *   dialect,
   *   executorFn: softDeleteExecutorFn,
   * })
   */
  executorFn?: SqliteExecutorFn<T, Extra>
}

interface TransactionOptions<T> {
  errorMsg?: string
  /**
   * after commit hook
   */
  onCommit?: (result: T) => Promisable<void>
  /**
   * after rollback hook
   */
  onRollback?: (err: unknown) => Promisable<void>
}

type PrecompileBuilder<DB extends Record<string, any>, T extends Record<string, any>> = {
  build: <O>(
    queryBuilder: (db: SqliteExecutor<DB>, param: <K extends keyof T>(name: K) => T[K]) => Compilable<O>
  ) => {
    [Symbol.dispose]: VoidFunction
    dispose: VoidFunction
    compile: (param: T) => CompiledQuery<QueryBuilderOutput<Compilable<O>>>
  }
}

export class SqliteBuilder<DB extends Record<string, any>, Extra extends Record<string, any> = {}> {
  private _kysely: Kysely<DB>
  public trxCount = 0
  private trx?: Transaction<DB>
  private logger?: DBLogger
  private executor: SqliteExecutor<DB, Extra>
  private serializer = defaultSerializer

  /**
   * current kysely / transaction instance
   */
  public get kysely() {
    return this.trx || this._kysely
  }

  /**
   * sqlite builder
   * @param options options
   * @example
   * import { SqliteDialect } from 'kysely'
   * import { SqliteBuilder } from 'kysely-sqlite-builder'
   * import Database from 'better-sqlite3'
   * import type { InferDatabase } from 'kysely-sqlite-builder/schema'
   * import { column, defineTable } from 'kysely-sqlite-builder/schema'
   * import { createSoftDeleteExecutorFn } from 'kysely-sqlite-builder/utils'
   *
   * const testTable = defineTable({
   *   columns: {
   *     id: column.increments(),
   *     person: column.object({ defaultTo: { name: 'test' } }),
   *     gender: column.boolean({ notNull: true }),
   *     // or
   *     // gender: { type: 'boolean', notNull: true },
   *     array: column.object().$cast<string[]>(),
   *     literal: column.string().$cast<'l1' | 'l2'>(),
   *     buffer: column.blob(),
   *   },
   *   primary: 'id',
   *   index: ['person', ['id', 'gender']],
   *   timeTrigger: { create: true, update: true },
   *   // enable soft delete
   *   softDelete: true,
   * })
   *
   * const DBSchema = {
   *   test: testTable,
   * }
   *
   * const builder = new SqliteBuilder<InferDatabase<typeof DBSchema>>({
   *   dialect: new SqliteDialect({
   *     database: new Database(':memory:'),
   *   }),
   *   logger: console,
   *   onQuery: true,
   *   // use soft delete
   *   executorFn: createSoftDeleteExecutorFn(),
   * })
   * await builder.execute(db => db.insertInto('test').values({ person: { name: 'test' }, gender: true }))
   *
   * builder.transaction(async (trx) => {
   *   // auto load transaction
   *   await builder.execute(db => db.insertInto('test').values({ gender: true }))
   *   // or
   *   // await trx.insertInto('test').values({ person: { name: 'test' }, gender: true }).execute()
   *   builder.transaction(async () => {
   *     // nest transaction, use savepoint
   *     await builder.execute(db => db.selectFrom('test').where('gender', '=', true))
   *   })
   * })
   *
   * // use origin instance
   * await builder.kysely.insertInto('test').values({ gender: false }).execute()
   *
   * // run raw sql
   * await builder.raw(sql`PRAGMA user_version = 2`)
   *
   * // destroy
   * await builder.destroy()
   */
  constructor(options: SqliteBuilderOptions<DB, Extra>) {
    const {
      dialect,
      logger,
      onQuery,
      plugins = [],
      serializerPluginOptions,
      executorFn = basicExecutorFn<DB>,
    } = options
    this.logger = logger

    if (serializerPluginOptions?.serializer) {
      this.serializer = serializerPluginOptions.serializer
    }
    plugins.push(new SerializePlugin(serializerPluginOptions))

    let log
    if (onQuery === true) {
      log = createKyselyLogger({
        logger: this.logger?.debug || console.log,
        merge: true,
      })
    } else if (onQuery) {
      log = createKyselyLogger(onQuery)
    }

    this._kysely = new Kysely<DB>({ dialect, log, plugins })
    this.executor = executorFn(() => this.kysely) as any
  }

  /**
   * sync db schema
   * @param updater sync table function, built-in: {@link useSchema}, {@link useMigrator}
   * @param checkIntegrity whether to check integrity
   * @example
   * import { useSchema } from 'kysely-sqlite-builder/schema'
   * import { useMigrator } from 'kysely-sqlite-builder'
   * import { FileMigrationProvider } from 'kysely'
   *
   * // update tables using schema
   * await builder.syncDB(useSchema(Schema, { logger: false }))
   *
   * // update tables using MigrationProvider and migrate to latest
   * await builder.syncDB(useMigrator(new FileMigrationProvider(...)))
   */
  public async syncDB(updater: TableUpdater, checkIntegrity?: boolean): Promise<StatusResult> {
    try {
      if (checkIntegrity && !(await runCheckIntegrity(this._kysely))) {
        this.logger?.error('integrity check fail')
        return { ready: false, error: new IntegrityError() }
      }
      const result = await updater(this._kysely, this.logger)
      this.logger?.info('table updated')
      return result
    } catch (error) {
      this.logError(error, 'sync table fail')
      return {
        ready: false,
        error,
      }
    }
  }

  private logError(e: unknown, errorMsg?: string) {
    errorMsg && this.logger?.error(errorMsg, e instanceof Error ? e : undefined)
  }

  /**
   * run in transaction, support nest call (using `savepoint`)
   */
  public async transaction<O>(
    fn: (trx: SqliteExecutor<DB, Extra>) => Promise<O>,
    options: TransactionOptions<O> = {},
  ): Promise<O | undefined> {
    if (!this.trx) {
      return await this._kysely.transaction()
        .execute(async (trx) => {
          this.trx = trx
          this.logger?.debug('run in transaction')
          return await fn(this.executor)
        })
        .then(async (result) => {
          await options.onCommit?.(result)
          return result
        })
        .catch(async (e) => {
          await options.onRollback?.(e)
          this.logError(e, options.errorMsg)
          return undefined
        })
        .finally(() => this.trx = undefined)
    }

    this.trxCount++
    this.logger?.debug(`run in savepoint: sp_${this.trxCount}`)
    const { release, rollback } = await savePoint(this.kysely, `sp_${this.trxCount}`)

    return await fn(this.executor)
      .then(async (result) => {
        await release()
        await options.onCommit?.(result)
        return result
      })
      .catch(async (e) => {
        await rollback()
        await options.onRollback?.(e)
        this.logError(e, options.errorMsg)
        return undefined
      })
      .finally(() => this.trxCount--)
  }

  /**
   * execute compiled query and return result list, auto detect transaction
   */
  public async execute<O>(
    query: CompiledQuery<O>,
  ): Promise<QueryResult<O>>
  /**
   * execute function and return result list, auto detect transaction
   */
  public async execute<O>(
    fn: (db: SqliteExecutor<DB, Extra>) => AvailableBuilder<DB, O>,
  ): Promise<Simplify<O>[] | undefined>
  public async execute<O>(
    data: CompiledQuery<O> | ((db: SqliteExecutor<DB, Extra>) => AvailableBuilder<DB, O>),
  ): Promise<QueryResult<O> | Simplify<O>[] | undefined> {
    return typeof data === 'function'
      ? await data(this.executor).execute()
      : await this.kysely.executeQuery(data)
  }

  /**
   * execute and return first result, auto detect transaction
   *
   * if is `select`, auto append `.limit(1)`
   */
  public async executeTakeFirst<O>(
    fn: (db: SqliteExecutor<DB, Extra>) => AvailableBuilder<DB, O>,
  ): Promise<Simplify<O> | undefined> {
    let _sql = fn(this.executor)
    if (SelectQueryNode.is(_sql.toOperationNode())) {
      _sql = (_sql as SelectQueryBuilder<DB, any, any>).limit(1)
    }
    return await _sql.executeTakeFirst()
  }

  /**
   * precompile query, call it with different params later, design for better performance
   * @example
   * const select = builder.precompile<{ name: string }>()
   *   .query((db, param) =>
   *     db.selectFrom('test').selectAll().where('name', '=', param('name')),
   *   )
   * const compileResult = select.compile({ name: 'test' })
   * // {
   * //   sql: 'select * from "test" where "name" = ?',
   * //   parameters: ['test'],
   * //   query: { kind: 'SelectQueryNode' } // only node kind by default
   * // }
   * select.dispose() // clear cached query
   *
   * // or auto disposed by using
   * using selectWithUsing = builder.precompile<{ name: string }>()
   *   .query((db, param) =>
   *     db.selectFrom('test').selectAll().where('name', '=', param('name')),
   *   )
   */
  public precompile<T extends Record<string, any>>(
    processRootOperatorNode: (node: RootOperationNode) => RootOperationNode = v => ({ kind: v.kind }) as any,
  ): PrecompileBuilder<DB, T> {
    this.logger?.debug?.('precompile')
    return {
      build: <O>(
        queryBuilder: (db: SqliteExecutor<DB>, param: <K extends keyof T>(name: K) => T[K]) => Compilable<O>,
      ) => {
        let compiled: CompiledQuery<Compilable<O>> | null
        const dispose = () => compiled = null
        return {
          [Symbol.dispose]: dispose,
          dispose,
          compile: (param: T) => {
            if (!compiled) {
              const { parameters, sql, query } = queryBuilder(this.executor, name => `__pre_${name as string}` as any).compile()
              compiled = {
                sql,
                query: processRootOperatorNode(query) as any,
                parameters,
              }
            }
            return {
              ...compiled,
              parameters: compiled.parameters.map((p) => {
                const key = (typeof p === 'string' && p.startsWith('__pre_')) ? p.slice(6) : undefined
                return key ? this.serializer(param[key]) : p
              }),
            }
          },
        }
      },
    }
  }

  /**
   * execute raw sql, auto detect transaction
   */
  public async raw<O = unknown>(
    rawSql: RawBuilder<O>,
  ): Promise<QueryResult<O | unknown>>
  /**
   * execute sql string, auto detect transaction
   */
  public async raw<O = unknown>(
    rawSql: string,
    parameters?: unknown[]
  ): Promise<QueryResult<O | unknown>>
  public async raw<O = unknown>(
    rawSql: RawBuilder<O> | string,
    parameters?: unknown[],
  ): Promise<QueryResult<O | unknown>> {
    return typeof rawSql === 'string'
      ? await this.kysely.executeQuery(CompiledQuery.raw(rawSql, parameters))
      : await rawSql.execute(this.kysely)
  }

  /**
   * optimize db file
   * @param rebuild if is true, run `vacuum` instead of `pragma optimize`
   * @see https://sqlite.org/pragma.html#pragma_optimize
   * @see https://www.sqlite.org/lang_vacuum.html
   */
  public async optimize(rebuild?: boolean) {
    await this.raw(rebuild ? 'vacuum' : 'pragma optimize')
  }

  /**
   * destroy db connection
   */
  public async destroy() {
    this.logger?.info('destroyed')
    await this._kysely.destroy()
    this.trx = undefined
  }
}

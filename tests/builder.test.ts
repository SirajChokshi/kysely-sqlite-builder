import { Database } from 'node-sqlite3-wasm'
import { NodeWasmDialect } from 'kysely-wasm'
import { beforeEach, describe, expect, it } from 'bun:test'
import { SqliteBuilder, createSoftDeleteExecutor } from '../src'
import type { InferDatabase } from '../src/schema'
import { DataType, column, defineTable, useSchema } from '../src/schema'
import { getOrSetDBVersion, optimizePragma } from '../src/pragma'

const testTable = defineTable({
  columns: {
    id: column.increments(),
    person: column.object({ defaultTo: { name: 'test' } }),
    gender: column.boolean({ notNull: true }),
    array: column.object().$cast<string[]>(),
    literal: column.string().$cast<'l1' | 'l2'>(),
  },
  primary: 'id',
  index: ['person', ['id', 'gender']],
  timeTrigger: { create: true, update: true },
})

const blobTable = defineTable({
  columns: {
    id: column.int({ notNull: true }),
    // better-sqlite3 always return Buffer
    // node sqlite wasm always return Uint8Array
    buffer: column.blob(),
    uint8: column.blob(),
  },
  primary: 'id',
})

const baseTables = {
  test: testTable,
  blob: blobTable,
}
type DB = InferDatabase<typeof baseTables>

function getDatabaseBuilder(debug = false) {
  return new SqliteBuilder<DB>({
    dialect: new NodeWasmDialect({
      database: new Database(':memory:'),
      async onCreateConnection(connection) {
        await optimizePragma(connection)
      },
    }),
    logger: console,
    onQuery: debug,
  })
}
describe('test sync table', async () => {
  let db: SqliteBuilder<any>
  beforeEach(async () => {
    db = getDatabaseBuilder()
    await db.syncDB(useSchema(baseTables, { log: false }))
  })
  it('should create new table', async () => {
    const foo = defineTable({
      columns: {
        col1: { type: DataType.increments },
        col2: { type: DataType.string },
      },
    })

    await db.syncDB(useSchema({
      ...baseTables,
      foo,
    }, { log: true }))

    const _tables = await db.kysely.introspection.getTables()
    expect(_tables.length).toBe(3)
    expect(_tables[0].name).toBe('blob')
    expect(_tables[1].name).toBe('foo')
    expect(_tables[2].name).toBe('test')
  })
  it('should drop old table', async () => {
    await db.syncDB(useSchema({ }, { log: true }))

    const _tables = await db.kysely.introspection.getTables()
    expect(_tables.length).toBe(0)
  })
  it('should update and diff same table with columns', async () => {
    const foo = defineTable({
      columns: {
        id: column.increments(),
        person: column.int(),
        bool: column.boolean({ notNull: true }),
        array: column.object().$cast<string[]>(),
        buffer: column.blob(),
        newColumn: column.int(),
      },
      primary: 'id',
      timeTrigger: { create: true, update: true },
    })
    await db.syncDB(useSchema({ test: foo }, { log: true }))
    const [_tables] = await db.kysely.introspection.getTables()
    expect(_tables
      .columns
      .filter(({ name }) => name === 'person')[0]
      .dataType,
    ).toBe('INTEGER')
    expect(_tables
      .columns
      .filter(({ name }) => name === 'gender')
      .length,
    ).toBe(0)
    expect(_tables
      .columns
      .filter(({ name }) => name === 'bool')[0]
      .dataType,
    ).toBe('INTEGER')
    expect(_tables
      .columns
      .filter(({ name }) => name === 'newColumn')[0]
      .dataType,
    ).toBe('INTEGER')
  })
})
describe('test builder', async () => {
  const db = getDatabaseBuilder()
  await getOrSetDBVersion(db.kysely, 2)
  // generate table
  await db.syncDB(useSchema(baseTables))
  it('should insert', async () => {
    console.log(await db.transaction(async () => {
      await db.insertInto('test').values([{ gender: false }, { gender: true }]).execute()
      return await db.updateTable('test').set({ gender: true }).where('id', '=', 2).returningAll().execute()
    }, {
      onCommit: () => {
        console.log('after commit')
      },
    }))
    const result = await db.selectFrom('test').selectAll().execute()
    expect(result).toBeInstanceOf(Array)
    expect(result![0].person).toStrictEqual({ name: 'test' })
    expect(result![0].gender).toBe(0)
    expect(result![0].createAt).toBeInstanceOf(Date)
    expect(result![0].updateAt).toBeInstanceOf(Date)
    const result2 = await db.selectFrom('test').selectAll().executeTakeFirst()
    expect(result2).toBeInstanceOf(Object)
    expect(result2!.person).toStrictEqual({ name: 'test' })
    expect(result2!.gender).toBe(0)
    expect(result2!.createAt).toBeInstanceOf(Date)
    expect(result2!.updateAt).toBeInstanceOf(Date)
  })
  it('should precompile', async () => {
    const select = db.precompile<{ person: { name: string }, test?: 'asd' }>()
      .build((db, param) =>
        db.selectFrom('test').selectAll().where('person', '=', param('person')),
      )
    const insert = db.precompile<{ gender: boolean }>()
      .build((db, param) =>
        db.insertInto('test').values({ gender: param('gender') }),
      )
    const update = db.precompile<{ gender: boolean }>()
      .build((db, param) =>
        db.updateTable('test').set({ gender: param('gender') }).where('id', '=', 1),
      )

    const start = performance.now()

    const { parameters, sql } = select.compile({ person: { name: '1' } })
    expect(sql).toBe('select * from "test" where "person" = ?')
    expect(parameters[0]).toBe('{"name":"1"}')

    const start2 = performance.now()
    console.log('no compiled:', `${(start2 - start).toFixed(2)}ms`)

    const { parameters: p1, sql: s1 } = select.compile({ person: { name: 'test' } })
    expect(s1).toBe('select * from "test" where "person" = ?')
    expect(p1).toStrictEqual(['{"name":"test"}'])

    console.log('   compiled:', `${(performance.now() - start2).toFixed(2)}ms`)

    const result = await db.execute(insert.compile({ gender: true }))
    expect(result.rows).toStrictEqual([])
    const result2 = await db.execute(update.compile({ gender: false }))
    expect(result2.rows).toStrictEqual([])
  })

  it('should soft delete', async () => {
    const softDeleteTable = defineTable({
      columns: {
        id: column.increments(),
        name: column.string(),
      },
      primary: 'id',
      softDelete: true,
    })
    const softDeleteSchema = {
      testSoftDelete: softDeleteTable,
    }

    const db = new SqliteBuilder<InferDatabase<typeof softDeleteSchema>>({
      dialect: new NodeWasmDialect({
        database: new Database(':memory:'),
        async onCreateConnection(connection) {
          await optimizePragma(connection)
        },
      }),
      executor: createSoftDeleteExecutor().executor,
      // onQuery: true,
    })
    await db.syncDB(useSchema(softDeleteSchema, { log: false }))

    const insertResult = await db.insertInto('testSoftDelete').values({ name: 'test' }).returning('isDeleted').executeTakeFirst()
    expect(insertResult?.isDeleted).toBe(0)

    await db.deleteFrom('testSoftDelete').where('id', '=', 1).execute()
    const selectResult = await db.selectFrom('testSoftDelete').selectAll().executeTakeFirst()
    expect(selectResult).toBeUndefined()

    const updateResult = await db.updateTable('testSoftDelete').set({ name: 'test' }).where('id', '=', 1).executeTakeFirst()
    expect(updateResult?.numUpdatedRows).toBe(0n)
  })
})

describe('test buffer type', async () => {
  const db = getDatabaseBuilder()
  await db.syncDB(useSchema(baseTables))
  // node sqlite wasm always return Uint8Array
  it('test Buffer', async () => {
    const testBuffer = Buffer.alloc(4).fill(0xDD)
    await db.insertInto('blob').values({ id: 0, buffer: testBuffer }).execute()
    const result = await db.selectFrom('blob').where('id', '=', 0).selectAll().executeTakeFirst()
    expect(result!.buffer).toStrictEqual(new Uint8Array(testBuffer.buffer))
    expect(result!.buffer).toBeInstanceOf(Uint8Array)
  })
  it('test Uint8Array', async () => {
    const testUint8Array = new Uint8Array([0x11, 0x22, 0x33, 0x44])
    await db.insertInto('blob').values({ id: 1, uint8: testUint8Array }).execute()
    const result = await db.selectFrom('blob').where('id', '=', 1).selectAll().executeTakeFirst()
    expect(result!.uint8).toStrictEqual(testUint8Array)
    expect(result!.uint8).toBeInstanceOf(Uint8Array)
  })
})

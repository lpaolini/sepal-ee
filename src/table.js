const ee = require('ee')
const _ = require('lodash')
const {concat} = require('rxjs')
const {map, switchMap, toArray} = require('rxjs/operators')
const {sequence} = require('./array')

const filterTable = ({tableId, columnName, columnValue}) => {
    const table = ee.FeatureCollection(tableId)
    if (columnName) {
        const filters = [ee.Filter.eq(columnName, columnValue)]
        if (!_.isNaN(_.toNumber(columnValue))) {
            filters.push(ee.Filter.eq(columnName, _.toNumber(columnValue)))
        }
        return table
            .cache()
            .filter(ee.Filter.or(...filters))
    } else {
        return table
    }
}

const ROW_CHUNK_SIZE = 5000

const getRows$ = (collection, description) => {
    const collectionSize$ =
        ee.getInfo$(
            collection.size(),
            'count rows'
        )

    const chunkCollection = size => {
        if (size <= ROW_CHUNK_SIZE)
            return [collection]

        const indexes = collection.aggregate_array('system:index')
            .zip(ee.List.sequence(0, size - 1))
            .map(indexTuple => ee.Feature(null, {
                systemIndex: ee.List(indexTuple).get(0),
                position: ee.List(indexTuple).get(1)
            }))
        const joined = ee.Join.saveFirst('__position__')
            .apply(collection, indexes, ee.Filter.equals({leftField: 'system:index', rightField: 'systemIndex'}))
            .map(feature => {
                const position = ee.Feature(feature.get('__position__'))
                    .getNumber('position')
                return feature.set('__position__', position)
            })
        const startPositions = sequence(0, size - 1, ROW_CHUNK_SIZE)
        return startPositions
            .map(start => {
                start = ee.Number(start)
                const end = start.add(ROW_CHUNK_SIZE)
                return joined
                    .filter(ee.Filter.and(
                        ee.Filter.greaterThanOrEquals('__position__', start),
                        ee.Filter.lessThan('__position__', end)
                    ))
                    .map(feature => ee.Feature(feature.geometry())
                        .copyProperties({source: feature, exclude: ['__position__']})
                    )
            })

    }

    const loadCollection$ = collection =>
        ee.getInfo$(collection, description)

    const mergeCollections = collections => {
        const features = collections.map(collection => collection.features).flat()
        const columns = features[0].properties
        return {columns, features}
    }

    return collectionSize$.pipe(
        switchMap(size =>
            concat(
                ...chunkCollection(size)
                    .map(collection => loadCollection$(collection))
            ).pipe(
                toArray()
            )),
        map(collections => mergeCollections(collections))
    )
}

module.exports = {
    filterTable,
    getRows$
}

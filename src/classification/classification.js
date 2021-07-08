const ee = require('ee')
const {map, switchMap, toArray} = require('rxjs/operators')
const {calculateIndex} = require('../optical/indexes')
const imageFactory = require('../imageFactory')
const {concat, defer, of, zip} = require('rxjs')
const _ = require('lodash')
const recipeRef = require('../recipeRef')

const NORMALIZE_MAX_PIXELS = 1e6

const classify =
    ({
        model: {
            inputImagery: {images: imageRecipes},
            legend,
            trainingData: {dataSets},
            auxiliaryImagery = [],
            classifier: classifierConfig,
            scale
        }
    },
    {selection: selectedBands} = {selection: []}
    ) => {
        const normalizeImage = image => {
            const minMax = image.reduceRegion({
                reducer: ee.Reducer.minMax(),
                scale: scale || 30,
                bestEffort: true,
                maxPixels: NORMALIZE_MAX_PIXELS
            })
            return ee.Image(ee.Image(
                image.bandNames().iterate((bandName, acc) => {
                    bandName = ee.String(bandName)
                    const min = minMax.getNumber(bandName.cat('_min'))
                    const max = minMax.getNumber(bandName.cat('_max'))
                    const band = image.select(bandName)
                    const scaled = ee.Image(ee.Algorithms.If(
                        min.eq(max),
                        band.divide(max),
                        unitScale(band, min, max)
                    ))
                    return ee.Image(acc).addBands(scaled)
                }, ee.Image([]))
            )
                .clip(image.geometry())
                .copyProperties(image, image.propertyNames()))
        }

        const recipeTrainingData$ = zip(...dataSets
            .filter(({type}) => type === 'RECIPE')
            .map(({recipe}) =>
                recipeRef({id: recipe}).getRecipe$().pipe(
                    switchMap(recipe => recipe.getTrainingData$())
                ))
        ).pipe(
            map(trainingDataSets => ee.FeatureCollection(trainingDataSets).flatten())
        )
        const referenceData = dataSets
            .filter(({type}) => type !== 'RECIPE')
            .map(({referenceData}) => referenceData)
            .flat()
        const toFeature = plot => {
            return ee.Feature(ee.Geometry.Point([plot['x'], plot['y']]), {'class': plot['class']})
        }
        const referenceDataCollection = ee.FeatureCollection(referenceData.map(toFeature))
        const imageToClassify$ = defer(() => zip(
            ...imageRecipes.map(recipe => toImage$(recipe, auxiliaryImagery))
        )).pipe(
            map(images => ee.Image(images)),
            map(imageToClassify => ['GRADIENT_TREE_BOOST', 'MINIMUM_DISTANCE', 'SVM'].includes(classifierConfig.type)
                ? normalizeImage(imageToClassify)
                : imageToClassify)
        )

        const getTrainingData$ = bands => {
            return imageToClassify$.pipe(
                switchMap(imageToClassify =>
                    concat(
                        recipeTrainingData$,
                        of(referenceDataCollection).pipe(
                            map(referenceDataCollection => {
                                return imageToClassify.sampleRegions({
                                    collection: referenceDataCollection.filterBounds(imageToClassify.geometry()),
                                    properties: ['class'],
                                    scale: scale || 1
                                })
                            })
                        )
                    ).pipe(
                        toArray(),
                        map(trainingDataSets =>
                            ee.FeatureCollection(trainingDataSets)
                                .flatten()
                                .set('band_order', bands || imageToClassify.bandNames())
                        )
                    )
                )
            )
        }

        const classify = (trainingData, imageToClassify) => {
            const classifier = classifierConfig.type === 'DECISION_TREE'
                ? createDecisionTreeClassifier(classifierConfig.decisionTree)
                : createClassifier(classifierConfig)
                    .train(trainingData, 'class')
                    .setOutputMode('CLASSIFICATION')
            return imageToClassify
                .classify(classifier)
                .uint8()
                .rename(['class'])
        }

        const createRegression = (trainingData, imageToClassify) => {
            const classifier = createClassifier(classifierConfig)
                .train(trainingData, 'class')
                .setOutputMode('REGRESSION')
            return imageToClassify
                .classify(classifier)
                .float()
                .rename(['regression'])
        }

        const calculateClassProbability = (trainingData, imageToClassify, classification) => {
            const probabilities = calculateProbabilities(trainingData, imageToClassify)
            const multipliers = ee.Image(legend.entries.map(({value}) =>
                ee.Image(1)
                    .where(classification.neq(value), 0)
                    .rename(`probability_${value}`)
            ))
            return probabilities
                .multiply(multipliers)
                .reduce(ee.Reducer.max())
                .rename('class_probability')
        }

        const calculateProbabilities = (trainingData, imageToClassify) => {
            const classifier = createClassifier(classifierConfig)
                .train(trainingData, 'class')
                .setOutputMode('MULTIPROBABILITY')
            const probabilityArrayImage = imageToClassify
                .classify(classifier)
                .multiply(100)
                .uint8()
            const classes = ee.List(classifier.explain().get('classes'))
            const indexes = ee.List.sequence(0, classes.size().subtract(1))
            const bandNames = legend.entries.map(({value}) => `probability_${value}`)
            return ee.Image(
                classes.zip(indexes).iterate((valueIndex, acc) => {
                    const value = ee.List(valueIndex).getNumber(0).int()
                    const index = ee.List(valueIndex).getNumber(1).int()
                    return ee.Image(acc).addBands(
                        probabilityArrayImage.arrayGet(index)
                            .rename(ee.String('probability_').cat(value.format()))
                    )
                }, ee.Image([]))
            ).addBands(ee.Image(bandNames.map(bandName => ee.Image(0).clip(imageToClassify.geometry()).rename(bandName)))).select(bandNames)
        }

        const classifyImage = (imageToClassify, selectedBands, trainingData) => {
            const bands = []
            if (selectedBands.includes('class') || selectedBands.includes('class_probability')) {
                const classification = classify(trainingData, imageToClassify)
                if (selectedBands.includes('class')) {
                    bands.push(classification)
                }
                if (selectedBands.includes('class_probability')) {
                    const classProbability = calculateClassProbability(trainingData, imageToClassify, classification)
                    bands.push(classProbability)
                }
            }
            if (selectedBands.includes('regression')) {
                const regression = createRegression(trainingData, imageToClassify)
                bands.push(regression)
            }
            const probabilityBands = selectedBands
                .filter(bandName => bandName.startsWith('probability_'))
            if (probabilityBands.length) {
                const probabilities = calculateProbabilities(trainingData, imageToClassify)
                    .select(probabilityBands)
                bands.push(probabilities)
            }
            return ee.Image(bands.flat())
        }

        return {
            getTrainingData$,
            getImage$() {
                return imageToClassify$.pipe(
                    switchMap(imageToClassify => {
                        return getTrainingData$(imageToClassify.bandNames()).pipe(
                            map(trainingData => classifyImage(imageToClassify, selectedBands, trainingData))
                        )
                    })
                )
            },
            getBands$() {
                const sortedLegend = _.sortBy(legend.entries, 'value')
                return of([
                    'class',
                    supportRegression(classifierConfig.type) && 'regression',
                    supportProbability(classifierConfig.type) && 'class_probability',
                    supportProbability(classifierConfig.type) && sortedLegend.map(({value}) => `probability_${value}`)
                ].flat().filter(band => band))

            },
            getVisParams$() {
                const sortedLegend = _.sortBy(legend.entries, 'value')
                const min = sortedLegend[0].value
                const max = _.last(sortedLegend).value
                const legendPalette = sortedLegend.map(({color}) => color)
                const probabilityPalette = '#000000,#480000,#710101,#BA0000,#FF0000,#FFA500,#FFFF00,#79C900,#006400'
                if (selectedBands.includes('class')) {
                    return of({bands: 'class', min, max, palette: legendPalette})
                } else if (selectedBands.includes('regression')) {
                    return of({bands: 'regression', min, max, palette: legendPalette})
                } else if (selectedBands.includes('class_probability')) {
                    return of({bands: 'class_probability', min: 0, max: 100, palette: probabilityPalette})
                } else {
                    const probabilityBands = selectedBands
                        .filter(bandName => bandName.startsWith('probability_'))
                    if (probabilityBands.length) {
                        return of({bands: probabilityBands[0], min: 0, max: 100, palette: probabilityPalette})
                    } else {
                        throw new Error(`Expected selected bands to contain class, regression, class_probability, or probability_*: ${JSON.stringify(selectedBands)}`)
                    }
                }
            },
            getGeometry$() {
                return imageFactory(imageRecipes[0]).getImage$().pipe(
                    map(image => image.geometry())
                )
            },
            classifyImage(image, bands, trainingData) {
                if (imageRecipes.length > 1) {
                    throw new Error('This recipe contains more than one inputImage. Cannot classify it')
                }
                const covariates = addCovariates(image, imageRecipes[0].bandSetSpecs, auxiliaryImagery)
                const imageWithCovariates = image.addBands(covariates, null, true)
                return classifyImage(imageWithCovariates, bands, trainingData)
            }
        }
    }

const toImage$ = (recipe, auxiliaryImagery) =>
    imageFactory(recipe).getImage$().pipe(
        map(image => addCovariates(image, recipe.bandSetSpecs, auxiliaryImagery))
    )

const addCovariates = (image, bandSetSpecs, auxiliaryImagery) => {
    return ee.Image(
        bandSetSpecs.map(({type, included, operation}) => {
            switch (type) {
            case 'IMAGE_BANDS':
                return image.selectExisting(included).addBands(
                    calculateIndexes(
                        image.select(
                            image.bandNames().filter(ee.Filter(
                                ee.Filter.inList('item', included).not()
                            ))
                        ),
                        included
                    ), null, true
                )
            case 'PAIR_WISE_EXPRESSION':
                return combinePairwise(image, included, operation)
            case 'INDEXES':
                return calculateIndexes(image, included)
            }
        })
    ).addBands(
        auxiliaryImagery.length && getAuxiliaryImagery(auxiliaryImagery)
    ).updateMask(
        image.mask().reduce(ee.Reducer.max())
    )

}

const getAuxiliaryImagery = auxiliaryImagery =>
    ee.Image(
        auxiliaryImagery.map(type => {
            switch (type) {
            case 'LATITUDE':
                return createLatitudeImage()
            case 'TERRAIN':
                return createTerrainImage()
            case 'WATER':
                return createSurfaceWaterImage()
            }
        })
    )

const createLatitudeImage = () =>
    ee.Image.pixelLonLat().select('latitude').float()

const createTerrainImage = () => {
    const elevation = ee.Image('USGS/SRTMGL1_003')
    const topography = ee.Algorithms.Terrain(elevation)
    const aspectRad = topography.select(['aspect']).multiply(ee.Number(Math.PI).divide(180))
    const eastness = aspectRad.sin().rename(['eastness']).float()
    const northness = aspectRad.cos().rename(['northness']).float()
    return topography.select(['elevation', 'slope', 'aspect'])
        .addBands(eastness)
        .addBands(northness)
}

const createSurfaceWaterImage = () => {
    const water = ee.Image('JRC/GSW1_0/GlobalSurfaceWater').unmask()
    const transitions = [
        'no_change',
        'permanent',
        'new_permanent',
        'lost_permanent',
        'seasonal',
        'new_seasonal',
        'lost_seasonal',
        'seasonal_to_permanent',
        'permanent_to_seasonal',
        'ephemeral_permanent',
        'ephemeral_seasonal'
    ]
    const transitionMasks = ee.Image(
        transitions.map((transition, i) =>
            water.select('transition').eq(i).rename(`water_${transition}`))
    )

    return water
        .select(
            ['occurrence', 'change_abs', 'change_norm', 'seasonality', 'max_extent'],
            ['water_occurrence', 'water_change_abs', 'water_change_norm', 'water_seasonality', 'water_max_extent']
        )
        .addBands(transitionMasks)
}

const combinePairwise = (image, bands, operation) => {
    const operations = {
        RATIO: 'b1 / b2',
        NORMALIZED_DIFFERENCE: '(b1 - b2) / (b1 + b2)',
        DIFFERENCE: 'b1 - b2',
        DISTANCE: 'atan2(b1, b2) / PI',
        ANGLE: 'hypot(b1, b2)'
    }
    return image
        .selectExisting(bands)
        .combinePairwise(operations[operation], `_${operation.toLowerCase()}`)
}

const calculateIndexes = (image, indexNames) =>
    ee.Image(
        indexNames.map(indexName => calculateIndex(image, indexName)
        )
    )

const createDecisionTreeClassifier = decisionTree => {
    try {
        decisionTree = JSON.parse(decisionTree)
        // eslint-disable-next-line no-empty
    } catch (e) {
    } // Probably a single decision tree string
    if (_.isArray(decisionTree)) {
        return ee.Classifier.decisionTreeEnsemble(decisionTree)
    } else if (_.isString(decisionTree)) {
        return ee.Classifier.decisionTree(decisionTree)
    } else {
        throw new Error('Decision tree must either be a JSON array with decision trees or a single decision tree string')
    }
}

const createClassifier = ({type, ...config}) => {
    const randomForest = ({numberOfTrees, variablesPerSplit, minLeafPopulation, bagFraction, maxNodes, seed}) =>
        ee.Classifier.smileRandomForest({
            numberOfTrees: toInt(numberOfTrees),
            variablesPerSplit: toInt(variablesPerSplit),
            minLeafPopulation: toInt(minLeafPopulation),
            bagFraction: toFloat(bagFraction),
            maxNodes: toInt(maxNodes),
            seed: toInt(seed)
        })

    const gradientTreeBoost = ({numberOfTrees, shrinkage, samplingRate, maxNodes, loss, seed}) => {
        return ee.Classifier.smileGradientTreeBoost({
            numberOfTrees: toInt(numberOfTrees),
            shrinkage: toFloat(shrinkage),
            samplingRate: toFloat(samplingRate),
            maxNodes: toInt(maxNodes),
            loss,
            seed: toInt(seed)
        })
    }

    const cart = ({minLeafPopulation, maxNodes}) =>
        ee.Classifier.smileCart({
            minLeafPopulation: toInt(minLeafPopulation),
            maxNodes: toInt(maxNodes)
        })

    const naiveBayes = ({lambda}) =>
        ee.Classifier.smileNaiveBayes({lambda: toFloat(lambda)})

    const svm = ({decisionProcedure, svmType, kernelType, shrinking, degree, gamma, coef0, cost, nu, oneClass}) =>
        ee.Classifier.libsvm({
            decisionProcedure,
            svmType,
            kernelType,
            shrinking,
            degree: kernelType === 'POLY' ? toInt(degree) : null,
            gamma: ['POLY', 'RBF', 'SIGMOID'].includes(kernelType) ? toFloat(gamma) : null,
            coef0: ['POLY', 'SIGMOID'].includes(kernelType) ? toFloat(coef0) : null,
            cost: svmType === 'C_SVC' ? toFloat(cost) : null,
            nu: svmType === 'NU_SVC' ? toFloat(nu) : null,
            oneClass: svmType === 'ONE_CLASS' ? toInt(oneClass) : null
        })

    const minimumDistance = ({metric}) =>
        ee.Classifier.minimumDistance({metric})

    switch (type) {
    case 'RANDOM_FOREST':
        return randomForest(config)
    case 'GRADIENT_TREE_BOOST':
        return gradientTreeBoost(config)
    case 'CART':
        return cart(config)
    case 'NAIVE_BAYES':
        return naiveBayes(config)
    case 'SVM':
        return svm(config)
    case 'MINIMUM_DISTANCE':
        return minimumDistance(config)
    }
}

const toInt = input => {
    input = _.isString(input) ? input : _.toString(input)
    const parsed = parseInt(input)
    return _.isFinite(parsed) ? parsed : null
}

const toFloat = input => {
    input = _.isString(input) ? input : _.toString(input)
    const parsed = parseFloat(input)
    return _.isFinite(parsed) ? parsed : null
}

const unitScale = (image, low, high) =>
    image
        .subtract(low)
        .divide(ee.Number(high).subtract(low))

const supportRegression = classifierType =>
    ['RANDOM_FOREST', 'GRADIENT_TREE_BOOST', 'CART'].includes(classifierType)

const supportProbability = classifierType =>
    ['RANDOM_FOREST', 'GRADIENT_TREE_BOOST', 'CART', 'SVM', 'NAIVE_BAYES'].includes(classifierType)

module.exports = classify

const {map, switchMap} = require('rxjs/operators')
const {loadRecipe$} = require('./recipe')
const imageFactory = require('./imageFactory')

const recipeRef = ({id}, ...args) => {
    const recipe$ = loadRecipe$(id).pipe(
        map(recipe => imageFactory(recipe, ...args))
    )
    return {
        getImage$() {
            return recipe$.pipe(
                switchMap(recipe => recipe.getImage$())
            )
        },
        getBands$() {
            return recipe$.pipe(
                switchMap(recipe => recipe.getBands$())
            )
        },
        getVisParams$() {
            return recipe$.pipe(
                switchMap(recipe => recipe.getVisParams$())
            )
        },
        getGeometry$() {
            return recipe$.pipe(
                switchMap(recipe => recipe.getGeometry$())
            )
        },
        getRecipe$() {
            return recipe$
        }
    }
}

module.exports = recipeRef

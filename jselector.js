const { jin, getType } = require('j')

/**
 * This is a simple version of jselector that offers more functionality at the cost of less magic missles.
 * There are two functions of concern, 
 * 1) the test function, which gets the value of the base reducer
 * 2) the value function, which derives the final value of the property to be returned
 * 
 * It is possible to test for multiple base reducer values by returning the multiple array (3rd argument)
 * (state, ownProps, multiple) => Object.assign(multiple, [ state.prop1, state.prop2, ownProps ])
 * 
 * On the value function, the order of the arguments are state, testValue, and ownProps
 * When there are multiple testValues, it is [ state, [ testValue1, testValue2, ... ], ownProps ]
 * 
 * @param {function} testFun
 * @param {function} valueFun 
 * @param {any} def 
 * @param {string} key 
 * @returns 
 */
export function simpleSelector (testFun, valueFun, def, key) {

  let oldTest
    , oldValue
    , meta = this || { changes : [] }

  return (state, props) => {

    const multiple = []

    let newTest = testFun(state, props, multiple)

    if (oldTest === newTest)
      return def !== undefined ? oldValue || def : oldValue

    // when testing multiple things, return the 'multiple' array with all of the values
    // jselector(
    //  (state, ownProps, multiple) => Object.assign(multiple, [ state.prop1, state.prop2, ownProps ])
    //  , (state, [ prop1, prop2, ownProps ]) => {
    //    ... code 
    //  }
    // )

    else if (newTest === multiple && (oldTest && !newTest.find(( item, index ) => item !== oldTest[ index ] )))
      return def !== undefined ? oldValue || def : oldValue

    oldTest = newTest

    const newValue = valueFun(state, newTest, props)

    if (newValue !== oldValue)
      meta.changes.push({ oldTest, def, key, newTest, newValue, oldValue })

    oldValue = newValue

    return def !== undefined ? newValue || def : newValue

  }

}

/**
 * This is a basic selector function which computes a value when the keys have changed in state.
 * 
 * @param { string[] } keys The keys of the State Object to determine if sel should compute
 * @param { function } sel The function to run that builds the final value
 * @param { function } [after] Optional function that can run after the value has been computed
 */
export function lightSelector (keys=[], sel=new Function(), after) {

  return s => {

    const r = { ret : sel(s) }

    keys.forEach( key => r[key] = s[key] )

    after && after(r, s, true)

    return s => {

      let truthy = true

      keys.forEach(key => {
        if (r[key] !== ( r[key] = s[key] ))
          truthy = false
      })

      if (!truthy) {
        r.ret = sel(s)
        after && after(r, s)
      }

      return r.ret

    }

  }

}

/**
 * This is the dumb selector
 * It actually just returns the whole thing every time
 * Basically it's only useful for cases where you don't know what 
 * reducers need to be monitored for changes
 * It is smart enough to flag when changes have been made causing the parent object to be updated
 * to show a meta change
 * 
 * There is another very useful feature for this single selector.
 * A use case would be when you have a list of items that all connect to state.
 * Let's say some of the properties are based on ownProps, but others are based on state properties.
 * The state properties would not change between each instance, so they could be statically cached
 * 
 * @param {any} path 
 * @param {any} filter 
 * @param {any} def 
 * @param {any} key 
 * @returns 
 */
function singleSelector (filter, unused, def, key) {

  const meta = this || { changes: [] }

  let previousValue

  return (state, props) => {

    let newValue = filter(state, props)

    if (previousValue === newValue)
      return def !== undefined ? previousValue || def : previousValue

    meta.changes.push({ key, props, newValue, previousValue })

    previousValue = newValue

    return def !== undefined ? newValue || def : newValue

  }

}

/*

// TODO: this tested only slightly faster than the looseDigger version. Surprisingly so!
// because of the safety aspects of looseDigger, I see no benefit to using this more strict version
// it is here only as an example

function buildRidgedDigger (split) {

  let body = "return root"

  for (var x = 0; x < split.length; x++)
    body += '["' + split[x] + '"]'

  return Function('root', body)

}
*/

const outputBracketed = str => "['" + str + "']"
const outputArrAsBrackets = arr => arr.reduce(( all, item ) => all + outputBracketed(item), "")
const buildConditionals = arr => arr.map(
  (value, index, arr) => "(thing = root" + outputArrAsBrackets( arr.slice(0, index + 1) ) + ")"
).join(" && ")

/**
 * This creates a function that digs into the nested properties of an object based on a path array
 * We are dynamically building the function to optimize performance. Test results show a 10X speed boost using this over jim for example
 * Only should be used when the call needs to be done over and over again
 * 
 * @param { string[array] } split 
 * @returns { function }
 */
function buildLooseDigger (split) {

  const earlyReturn = split.length === 0 ? "return root" : ""

  const body = earlyReturn ? earlyReturn : `let thing = root;

    if (${ buildConditionals(split) })
      return thing;
      
    if (thing !== undefined)
      return thing`

  return Function('root', body)

}

/**
 * This is the more elaborate and user friendly version of jselector. Takes a string path and returns that value highly efficiently
 * Also allows you to filter that value further, but only when that value changes
 * assumes that the first level of the path is a reducer, so it should change when any value inside changes
 * 
 * @param {any} path 
 * @param {any} filter 
 * @param {any} def 
 * @param {any} key 
 * @returns 
 */
function _jselector(path, filter, def, key) {

  const meta = this || { changes : [] }

  let previousValue
    , previousPreValue
    , storedCompareValue
    , split
    , digMethod
    , isProps
    , isOwnProps
    , testMethod

  // if you want to just have a path, and a default, this makes that cleaner
  if (filter !== undefined && typeof filter !== "function") {
    def = filter
    filter = null
  }

  // if it's a property of ownProps
  if ((isProps = (path.indexOf("ownProps.") === 0)))
    path = path.substr(9)

  // if it's the whole ownProps
  if ((isOwnProps = (path === "ownProps")))
    path = ""

  split = path.split(".")

  // method to test the state for changes, assume first item
  // if we are testing ownProps, then that is handled at the contruction of the function to reduce one more logical point at run time
  testMethod = Function('root', 'ownProps', isOwnProps ? 'return ownProps' : isProps ? `return ownProps[ '${ split[0] }' ]` : `return root[ '${ split[0] }' ]`)

  // if there are magic marks, then it's a jin function, and use that for digging into results
  if (path.indexOf("*") === -1)
    digMethod = buildLooseDigger( split.slice(1) )
  else
    digMethod = testValue => jin("", testValue, undefined, 0, false, split.slice(1))

  return (state, props) => {

    // source can either be state or ownProps, based on the path
    // if the path starts with ownProps, then it's ownProps
    const testValue = testMethod(state, props)

    // if the testValue is the same, everything else will return the same too
    if (testValue === storedCompareValue)
      return def !== undefined ? previousValue || def : previousValue

    let newValue
      , preValue = digMethod(testValue)

    // if the new value is not the same, then we need to check for filters on it
    if (preValue !== previousPreValue) {

      // stored for next time
      previousPreValue = preValue

      // build newValue
      newValue = filter ? filter(preValue, state, props) : preValue

      // we store changes in an array, that can be picked up for debugging purposes in the final callback
      // for speed, find out if this slows things down
      if (newValue !== previousValue)
        meta.changes.push({ previousValue, key, newValue, path, props, storedCompareValue, testValue })

      // store the new perviousValue
      previousValue = newValue

    }

    // storing this here, in the case that the root value is different, but the final value is the same
    storedCompareValue = testValue

    // lets return the newValue or the default value if it's not defined
    return def !== undefined ? previousValue || def : previousValue

  }

}

/**
 * This generates an optimized version of the code that loops over each selector and applies (state, props)
 * Speed tests show a 12X increase in speed vs even a while loop
 * this breaks each item down by key name
 * 
 * @param {any} selectors 
 * @returns 
 */
function optimizedSelectorsLoop (selectors, preObj) {

  let body = ""

  if (preObj)
    body += "Object.assign(r, preObj); "

  for (var x in selectors)
    body += `r['${ x }'] = selectors['${ x }'](state, props);`

  body += "return r"

  return new Function("state", "props", "selectors", "r", "preObj", body)

}

/**
 * This takes a group of selectors and runs them, if there are no changes, it returns the existing object
 * 
 * @param {any} obj 
 * @param {any} fun 
 * @returns 
 */
export function jselectors (obj, fun, preObj) {

  let previousValue

  // selectors are stored here
  const selectors = {}
    , meta = this || { changes : [] }
    , mpc = meta.parent ? meta.parent.changes : null

  if (typeof fun === "object") {
    preObj = fun
    fun = null
  }

  // this builds out the selectors, based on arguments passed in
  for (var x in obj)
    if (obj[x])
      // allows you to either just pass in the path or object, or all arguments
      selectors[x] = (getType(obj[x]) === "_Array") ?
        jselector.call( meta, obj[x][0], obj[x][1], obj[x][2], x, true ) 
        : jselector.call( meta, obj[x], undefined, undefined, x, true )

  // speed tests show that spelling out the keys is far better than running them through a loop, rougly 12X
  // we are pre building this since it needs to be called on each state change, resulting in major speed improvements
  const selectorsLoop = optimizedSelectorsLoop(selectors, preObj)

  return function ret (state, props) {

    // using the optimized way of looping over all selectors
    // preObj only gets assigned to the r object if it exists
    // normally it will not so lets save that logic
    const r = selectorsLoop(
      state
      , props
      , selectors
      , {}
      , preObj
    )

    // if this is the first time or there are some changes then run it
    // all child selectors test for changes individually. If there are changes
    // they get reflected in the meta.changes object
    // the previousValue will always be an object unless it's the first time
    if (!previousValue || meta.changes.length) {

      // this is the function for the final callback
      // if you want to debug jselectors, put a break point in the final callback 
      // and check the third argument to see the full meta.changes array
      if (fun)
        // using assign here, to preserve the r object as is
        // the fun must return an object
        Object.assign(r, fun(r, state, props, meta))

      // now lets preserve this object and reuse if the results end up the same
      previousValue = r

      // since jselectors can be composed, there is the concept of a parent
      // mpc means meta.parent.changes
      // if there are any local changes, push them up to the parent
      // this is done here, after the fun has been called, not before
      if (mpc)
        mpc.push.apply( mpc, meta.changes )

      // local changes array gets cleared on each pass
      meta.changes.length = 0

    }

    // always return previousValue, updated or not
    return previousValue

  }

}

/**
 * This function relays between the different types of jselector functions
 * Since jselector builds a function that gets called again and again with scope
 * we can be slightly less efficient here since it only happens in the instantiation phase
 * 
 * @returns 
 */
export default function jselector () {

  const a = arguments

    // this is only for composed jselectors (object version)
    // this allows jselectors to contain child jselectors
    // when changes are present, they get passed up to the parent
    , subSelf = getType(a[4]) === "_Boolean" ? { parent : this, changes : [] } : this

  if (getType(a[0]) === "_Object")
    return jselectors.apply(subSelf, a)

  if (getType(a[0]) === "_Function" && getType(a[1]) === "_Function")
    return simpleSelector.apply(this, a)

  if (getType(a[0]) === "_Function")
    return singleSelector.apply(this, a)

  return _jselector.apply(this, a)

}

/**
 * this is really a utility to create a unique instance of a scoped function based upon some kind of key
 * 
 * A highly specialized use case being a selector.
 * 
 * @param {*} fun 
 * @param {*} map 
 */
export const wrapByUniqueKey = (fun, map={}) => (...args1) => (key, ...args2) => 
( map[key] || (map[key] = fun.call(this, ...args1)) ).call( this, ...args2 )
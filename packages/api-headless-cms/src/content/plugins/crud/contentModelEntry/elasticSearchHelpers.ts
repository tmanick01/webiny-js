import {
    CmsContentModelEntryListOptionsType,
    CmsContentModelEntryListSortType,
    CmsContentModelEntryListWhereType,
    CmsContentModelType,
    CmsContext,
    CmsModelFieldToGraphQLPlugin,
    ElasticSearchQueryBuilderPlugin,
    ElasticSearchQueryType
} from "@webiny/api-headless-cms/types";
import { decodeElasticSearchCursor } from "@webiny/api-headless-cms/utils";

type ModelFieldType = {
    unmappedType?: string;
    isSearchable: boolean;
    isSortable: boolean;
};
type ModelFieldsType = Record<string, ModelFieldType>;

type CreateElasticSearchParamsArgType = {
    where?: CmsContentModelEntryListWhereType;
    sort?: CmsContentModelEntryListSortType;
    limit: number;
    after?: string;
};
type CreateElasticSearchParamsType = {
    context: CmsContext;
    model: CmsContentModelType;
    args: CreateElasticSearchParamsArgType;
    ownedBy?: string;
    parentObject?: string;
    options?: CmsContentModelEntryListOptionsType;
};
type CreateElasticSearchSortParamsType = {
    sort: CmsContentModelEntryListSortType;
    modelFields: ModelFieldsType;
    parentObject?: string;
    model: CmsContentModelType;
};
type CreateElasticSearchQueryArgsType = {
    model: CmsContentModelType;
    context: CmsContext;
    where: CmsContentModelEntryListWhereType;
    modelFields: ModelFieldsType;
    ownedBy?: string;
    parentObject?: string;
    options?: CmsContentModelEntryListOptionsType;
};
type ElasticSearchSortParamType = {
    order: string;
};
type ElasticSearchSortFieldsType = Record<string, ElasticSearchSortParamType>;

const parseWhereKeyRegExp = new RegExp(/^([a-zA-Z0-9]+)_?([a-zA-Z0-9_]+)$/);
const parseWhereKey = (key: string) => {
    const match = key.match(parseWhereKeyRegExp);
    if (!match) {
        throw new Error(`It is not possible to search by key "${key}"`);
    }
    const [field, op = "eq"] = match;
    return {
        field,
        op
    };
};

const sortRegExp = new RegExp(/^([a-zA-Z-0-9_]+)_(ASC|DESC)$/);

const creteElasticSearchSortParams = (
    args: CreateElasticSearchSortParamsType
): ElasticSearchSortFieldsType[] => {
    const { sort, modelFields, model, parentObject } = args;
    const checkIsSystemField = (field: string) => {
        return !!model[field];
    };
    const withParentObject = (field: string) => {
        if (!parentObject) {
            return null;
        }
        return `${parentObject}.${field}`;
    };
    return sort.map(value => {
        const match = value.match(sortRegExp);
        if (!match) {
            throw new Error(`Cannot sort by "${value}".`);
        }
        const [field, order] = match;
        const isSystemField = checkIsSystemField(field);
        if (!modelFields[field] && !isSystemField) {
            throw new Error(`It is not possible to sort by field "${field}".`);
        } else if (!modelFields[field].isSortable && !isSystemField) {
            throw new Error(`Field "${field}" is not sortable.`);
        }
        const fieldName = isSystemField ? field : withParentObject(field);
        return {
            [fieldName]: {
                order: order.toLowerCase() === "asc" ? "asc" : "desc",
                // eslint-disable-next-line @typescript-eslint/camelcase
                unmapped_type: modelFields[field].unmappedType || undefined
            }
        };
    });
};

const createInitialQueryValue = (
    args: CreateElasticSearchQueryArgsType
): ElasticSearchQueryType => {
    const { ownedBy, options, model, context } = args;
    const query: ElasticSearchQueryType = {
        match: [],
        must: [
            // always search by given model id
            {
                term: {
                    "modelId.keyword": model.modelId
                }
            },
            // and in the given locale
            {
                term: {
                    "locale.keyword": context.cms.getLocale().code
                }
            }
        ],
        mustNot: [],
        should: []
    };
    // when permission has own property, this value is passed into the fn
    if (ownedBy) {
        query.must.push({
            term: {
                "ownedBy.id.keyword": ownedBy
            }
        });
    }
    // add more options if necessary
    const { type } = options || {};
    if (type) {
        query.must.push({
            term: {
                "__type.keyword": type
            }
        });
    }
    //
    return query;
};
/*
 * Iterate through where keys and apply plugins where necessary
 */
const execElasticSearchBuildQueryPlugins = (
    args: CreateElasticSearchQueryArgsType
): ElasticSearchQueryType => {
    const { where, modelFields, parentObject, model, context } = args;
    const query = createInitialQueryValue(args);

    const checkIsSystemField = (field: string) => {
        return !!model[field];
    };
    const withParentObject = (field: string) => {
        if (!parentObject) {
            return null;
        }
        return `${parentObject}.${field}`;
    };

    const plugins = context.plugins.byType<ElasticSearchQueryBuilderPlugin>(
        "elastic-search-query-builder"
    );

    for (const key in where) {
        if (where.hasOwnProperty(key) === false) {
            continue;
        }
        const { field, op } = parseWhereKey(key);
        const isSystemField = checkIsSystemField(field);
        if (!modelFields[field] && !isSystemField) {
            throw new Error(`There is no field "${field}".`);
        } else if (!modelFields[field].isSearchable && !isSystemField) {
            throw new Error(`Field "${field}" is not searchable.`);
        }
        for (const plugin of plugins) {
            if (plugin.targetOperation !== op) {
                continue;
            }
            const fieldWithParent = isSystemField ? null : withParentObject(field);
            plugin.apply(query, {
                field: fieldWithParent || field,
                value: where[key],
                parentObject,
                originalField: fieldWithParent ? field : undefined
            });
        }
    }
    return query;
};

const ES_LIMIT_MAX = 10000;
const ES_LIMIT_DEFAULT = 50;

export const createElasticSearchLimit = (
    limit: number,
    defaultValue = ES_LIMIT_DEFAULT
): number => {
    if (!limit) {
        return defaultValue;
    }
    if (limit < ES_LIMIT_MAX) {
        return limit;
    }
    return ES_LIMIT_MAX - 1;
};

/*
 * Create an object with key fieldType and options for that field
 */
const createModelFieldOptions = (
    context: CmsContext,
    model: CmsContentModelType
): ModelFieldsType => {
    const plugins = context.plugins.byType<CmsModelFieldToGraphQLPlugin>(
        "cms-model-field-to-graphql"
    );

    const modelFields = model.fields.map(field => {
        return field.type;
    });

    return plugins.reduce((acc, pl) => {
        const { fieldType, es, isSearchable, isSortable } = pl;
        if (modelFields.includes(fieldType) === false) {
            return acc;
        }
        const { unmappedType } = es || {};
        acc[pl.fieldType] = {
            unmappedType: unmappedType || null,
            isSearchable: isSearchable === true,
            isSortable: isSortable === true
        };
        return acc;
    }, {});
};

export const createElasticSearchParams = (params: CreateElasticSearchParamsType) => {
    const { context, model, args, ownedBy, parentObject = null, options } = params;
    const { where, after, limit, sort } = args;

    const modelFields = createModelFieldOptions(context, model);

    const query = execElasticSearchBuildQueryPlugins({
        model,
        context,
        where,
        modelFields,
        ownedBy,
        parentObject,
        options
    });
    return {
        query: {
            // eslint-disable-next-line @typescript-eslint/camelcase
            constant_score: {
                bool: {
                    must: query.must.length > 0 ? query.must : undefined,
                    // eslint-disable-next-line @typescript-eslint/camelcase
                    must_not: query.mustNot.length > 0 ? query.mustNot : undefined,
                    match: query.match.length > 0 ? query.match : undefined,
                    should: query.should.length > 0 ? query.should : undefined
                }
            }
        },
        sort: creteElasticSearchSortParams({ sort, modelFields, parentObject, model }),
        size: limit + 1,
        // eslint-disable-next-line
        search_after: decodeElasticSearchCursor(after)
    };
};
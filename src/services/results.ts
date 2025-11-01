import { ResponseModel } from '../models.js';

export interface AggregatedResults {
    byChoice: { choiceId: string | null; count: number }[];
    texts: { text: string }[];
    numbers: { values: number[] }[];
    totals: { total: number }[];
}

export async function aggregateResults(formId: string, questionId: string): Promise<AggregatedResults> {
    const pipeline = [
        { $match: { formId, questionId } },
        {
            $facet: {
                byChoice: [
                    { $unwind: { path: '$value.choiceIds', preserveNullAndEmptyArrays: true } },
                    { $group: { _id: '$value.choiceIds', count: { $sum: 1 } } },
                    { $project: { choiceId: '$_id', count: 1, _id: 0 } }
                ],
                texts: [
                    { $match: { 'value.text': { $exists: true, $ne: null } } },
                    { $project: { text: '$value.text', _id: 0 } }
                ],
                numbers: [
                    { $match: { 'value.number': { $exists: true, $ne: null } } },
                    { $group: { _id: null, values: { $push: '$value.number' } } },
                    { $project: { _id: 0, values: 1 } }
                ],
                totals: [{ $count: 'total' }]
            }
        }
    ];
    const [result] = await ResponseModel.aggregate<AggregatedResults>(pipeline);
    return result ?? { byChoice: [], texts: [], numbers: [], totals: [{ total: 0 }] };
}

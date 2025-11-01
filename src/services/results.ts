import { ResponseModel } from '../models.js';

export async function aggregateResults(formId: string, questionId: string) {
    // Regroupe count par choiceId, et collecte texte pour word cloud côté client
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
    const [res] = await ResponseModel.aggregate(pipeline);
    return res || { byChoice: [], texts: [], numbers: [], totals: [{ total: 0 }] };
}

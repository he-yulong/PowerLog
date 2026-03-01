import { useState } from 'react';

const TrainingEntryForm = ({ onEntryAdded }) => {
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    exercise_type: 'squat',
    exercise_name: 'Squat',
    weight: '0',
    weight_unit: 'kg',
    sets: '1',
    reps: '1',
    rpe: '5',
    notes: ''
  });

  const [error, setError] = useState('');

  const exerciseOptions = [
    { value: 'squat', label: 'Squat' },
    { value: 'bench', label: 'Bench Press' },
    { value: 'deadlift', label: 'Deadlift' },
    { value: 'custom', label: 'Custom' }
  ];

  const handleChange = (e) => {
    const { name, value } = e.target;

    if (name === 'exercise_type') {
      const exerciseMap = {
        squat: 'Squat',
        bench: 'Bench Press',
        deadlift: 'Deadlift',
        custom: ''
      };
      setFormData({
        ...formData,
        exercise_type: value,
        exercise_name: exerciseMap[value]
      });
    } else {
      setFormData({ ...formData, [name]: value });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Validation
    if (formData.weight === '' || parseFloat(formData.weight) < 0) {
      setError('Weight must be 0 or greater');
      return;
    }
    if (!formData.sets || parseInt(formData.sets) < 1) {
      setError('Sets must be at least 1');
      return;
    }
    if (!formData.reps || parseInt(formData.reps) < 1) {
      setError('Reps must be at least 1');
      return;
    }
    if (formData.exercise_type === 'custom' && !formData.exercise_name.trim()) {
      setError('Please provide a custom exercise name');
      return;
    }

    const payload = {
      date: formData.date,
      exercise_type: formData.exercise_type,
      exercise_name: formData.exercise_name,
      weight: parseFloat(formData.weight),
      weight_unit: formData.weight_unit,
      sets: parseInt(formData.sets),
      reps: parseInt(formData.reps),
      rpe: formData.rpe ? parseFloat(formData.rpe) : null,
      notes: formData.notes || null
    };

    try {
      const response = await fetch('http://localhost:8000/api/training/entries/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(JSON.stringify(errorData));
      }

      const data = await response.json();

      // Reset form
      setFormData({
        date: new Date().toISOString().split('T')[0],
        exercise_type: 'squat',
        exercise_name: 'Squat',
        weight: '0',
        weight_unit: 'kg',
        sets: '1',
        reps: '1',
        rpe: '5',
        notes: ''
      });

      if (onEntryAdded) {
        onEntryAdded(data);
      }
    } catch (err) {
      setError(`Failed to add entry: ${err.message}`);
    }
  };

  return (
    <div className="training-entry-form">
      <h2>Add Training Entry</h2>
      {error && <div className="error-message">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="date">Date:</label>
          <input
            type="date"
            id="date"
            name="date"
            value={formData.date}
            onChange={handleChange}
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="exercise_type">Exercise:</label>
          <select
            id="exercise_type"
            name="exercise_type"
            value={formData.exercise_type}
            onChange={handleChange}
            required
          >
            {exerciseOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {formData.exercise_type === 'custom' && (
          <div className="form-group">
            <label htmlFor="exercise_name">Custom Exercise Name:</label>
            <input
              type="text"
              id="exercise_name"
              name="exercise_name"
              value={formData.exercise_name}
              onChange={handleChange}
              required
            />
          </div>
        )}

        <div className="form-group">
          <label htmlFor="weight">Weight:</label>
          <input
            type="number"
            id="weight"
            name="weight"
            value={formData.weight}
            onChange={handleChange}
            step="0.01"
            min="0"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="weight_unit">Unit:</label>
          <select
            id="weight_unit"
            name="weight_unit"
            value={formData.weight_unit}
            onChange={handleChange}
            required
          >
            <option value="kg">Kilograms (kg)</option>
            <option value="lbs">Pounds (lbs)</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="sets">Sets:</label>
          <input
            type="number"
            id="sets"
            name="sets"
            value={formData.sets}
            onChange={handleChange}
            min="1"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="reps">Reps:</label>
          <input
            type="number"
            id="reps"
            name="reps"
            value={formData.reps}
            onChange={handleChange}
            min="1"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="rpe">RPE (optional):</label>
          <input
            type="number"
            id="rpe"
            name="rpe"
            value={formData.rpe}
            onChange={handleChange}
            step="0.5"
            min="0"
            max="10"
          />
        </div>

        <div className="form-group">
          <label htmlFor="notes">Notes (optional):</label>
          <textarea
            id="notes"
            name="notes"
            value={formData.notes}
            onChange={handleChange}
            rows="3"
          />
        </div>

        <button type="submit" className="submit-button">Add Entry</button>
      </form>
    </div>
  );
};

export default TrainingEntryForm;

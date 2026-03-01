from django.urls import path
from .views import TrainingEntryListCreateView, TrainingEntryDetailView

urlpatterns = [
    path('entries/', TrainingEntryListCreateView.as_view(), name='training-entry-list-create'),
    path('entries/<int:pk>/', TrainingEntryDetailView.as_view(), name='training-entry-detail'),
]
